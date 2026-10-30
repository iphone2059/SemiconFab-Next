import { Cause, Effect, Option, Queue, Schema, Stream } from 'effect';
import type {
  CommandConnectionStatus,
  CommandCursor,
  CommandEventSource,
  CommandProtocolDiagnostic,
  CommandProtocolDiagnosticKind,
  CommandResultEvent,
  CommandSourceCursors,
  CommandStreamDirty,
  CommandStreamDirtyReason,
  CommandStreamGap,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import { type CommandDirtyReason, commandDirtySchema } from '@/api/command-recovery.schema';
import {
  COMMAND_RESULT_TOPIC,
  MessageDecoder,
  RealtimeDecodeError,
  type DecodedRealtimeMessage,
} from '@/realtime/message-decoder';

interface SseMessageLike {
  readonly data: string;
  /** SSE id: line; the command journal writes {epoch}:{sequence}. */
  readonly lastEventId?: string;
}

interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((event: SseMessageLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  /** Browser EventSource named-event API; optional for test doubles of the command stream. */
  addEventListener?: (type: string, listener: (event: SseMessageLike) => void) => void;
  removeEventListener?: (type: string, listener: (event: SseMessageLike) => void) => void;
  close(): void;
}

/**
 * The CommandTransportScope side of the transport contract: the transport never
 * creates or owns a detached Scope. The owner registers a synchronous finalizer
 * that closes the EventSource and clears every timer.
 */
export interface CommandTransportFinalizerHost {
  addFinalizer(finalizer: () => void): void;
}

export interface SseCommandEventSourceOptions {
  /** CommandTransportScope finalizer registration (ADR-007 §2/§5). */
  readonly host: CommandTransportFinalizerHost;
  /** Test seam; production defaults to the browser EventSource. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  /** Per-signal bounded buffer capacity (ADR-007 §5 target: 256). */
  readonly capacity?: number;
  /** A connection that never opens is failed and retried after this delay. */
  readonly connectTimeoutMs?: number;
  /** Delay before a failed/interrupted connection is reopened. */
  readonly reconnectDelayMs?: number;
  /**
   * Ordered ACK ledger bound (ADR-010 §6.2). Reaching the bound is a Dirty signal
   * and blocks further ACK tracking; pending entries are never evicted to advance
   * the acknowledged cursor (default 256).
   */
  readonly ackLedgerCapacity?: number;
}

export const DEFAULT_ACK_LEDGER_CAPACITY = 256;
export const MAX_PROTOCOL_DIAGNOSTICS = 16;

type BufferPolicy = 'mark-dirty' | 'coalesce-newest';

interface PublishOutcome {
  /** At least one consumer queue accepted the value. */
  readonly accepted: boolean;
  /** Consumers whose bounded queue was full (the frame is lost for them). */
  readonly dropped: number;
}

interface LossEpisode {
  gapStart: number;
  gapEnd: number;
}

/** Ordered ACK ledger status (ADR-010 §6.2). */
type AckLedgerStatus = 'pending' | 'applied' | 'covered';

interface AckLedgerEntry {
  readonly epoch: string;
  readonly sequence: number;
  readonly fabId: string;
  readonly commandId: string;
  readonly revision: number;
  status: AckLedgerStatus;
}

/**
 * Server-classified dirty causes (CommandDirtyDto) mapped onto the transport
 * reasons. They require authoritative reconciliation and may never be mistaken
 * for a safely delivered journal position.
 */
const SERVER_DIRTY_REASON: Record<CommandDirtyReason, CommandStreamDirtyReason> = {
  'retention-trim': 'server-overflow',
  'epoch-replaced': 'stale-generation',
  'store-fault': 'store-fault',
};

function parseServerDirty(data: string): { reason: CommandDirtyReason; droppedCount: number; epoch: string; sequence: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    const decoded = Schema.decodeUnknownOption(commandDirtySchema)(parsed);
    if (Option.isNone(decoded)) return undefined;
    const { reason, droppedCount, epoch, sequence } = decoded.value;
    return { reason, droppedCount, epoch, sequence };
  } catch {
    return undefined;
  }
}

/** Monotonic per-epoch cursor advance for diagnostics-only cursors. */
function advanceCursor(current: CommandCursor | undefined, candidate: CommandCursor): CommandCursor {
  if (!current) return candidate;
  if (current.epoch === candidate.epoch) {
    return candidate.sequence >= current.sequence ? candidate : current;
  }
  return candidate;
}

/**
 * The acknowledged (safe) cursor can only advance inside the epoch it was
 * established in; an epoch switch is an authoritative-cover decision, never a
 * side effect of data frames/acks.
 */
function advanceSafeAcknowledged(current: CommandCursor | undefined, candidate: CommandCursor): CommandCursor {
  if (!current) return candidate;
  if (current.epoch !== candidate.epoch) return current;
  return candidate.sequence > current.sequence ? candidate : current;
}

/**
 * One bounded signal channel. Values are published synchronously from the
 * EventSource callbacks into per-consumer Stream.callback queues.
 *
 * - mark-dirty: a full consumer queue means the frame cannot be delivered, so
 *   the caller records the exact loss (never silent);
 * - coalesce-newest: the channel is a dirty signal itself; the sliding queue
 *   keeps the newest state and the monotonic droppedCount carries the accounting.
 */
class BoundedSignal<A> {
  private readonly queues = new Set<Queue.Queue<A, Cause.Done>>();
  private subscriberListener?: () => void;
  readonly stream: Stream.Stream<A>;

  constructor(
    private readonly capacity: number,
    private readonly policy: BufferPolicy,
  ) {
    this.stream = Stream.callback<A>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            this.queues.add(queue);
            this.subscriberListener?.();
          }),
          () =>
            Effect.sync(() => {
              this.queues.delete(queue);
              this.subscriberListener?.();
            }),
        ),
      { bufferSize: capacity, strategy: 'sliding' },
    );
  }

  onSubscriberChange(listener: () => void): void {
    this.subscriberListener = listener;
  }

  publish(value: A): PublishOutcome {
    let accepted = false;
    let dropped = 0;
    for (const queue of this.queues) {
      if (this.policy === 'mark-dirty' && Queue.sizeUnsafe(queue) >= this.capacity) {
        dropped += 1;
        continue;
      }
      Queue.offerUnsafe(queue, value);
      accepted = true;
    }
    return { accepted, dropped };
  }

  get subscriberCount(): number {
    return this.queues.size;
  }
}

/** Parse the journal cursor written in the SSE id line: {epoch}:{sequence}. */
export function parseCommandCursor(lastEventId: string | undefined): { epoch?: string; sequence?: number } {
  if (!lastEventId) return {};
  const separator = lastEventId.lastIndexOf(':');
  if (separator <= 0) return {};
  const epoch = lastEventId.slice(0, separator);
  const rawSequence = lastEventId.slice(separator + 1);
  if (!/^\d+$/.test(rawSequence)) return { epoch };
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? { epoch, sequence } : { epoch };
}

/** Complete cursor or undefined when the SSE id line is missing/malformed. */
function parseFullCursor(lastEventId: string | undefined): CommandCursor | undefined {
  const parsed = parseCommandCursor(lastEventId);
  if (parsed.epoch === undefined || parsed.sequence === undefined) return undefined;
  return { epoch: parsed.epoch, sequence: parsed.sequence };
}

/** Tolerant parse of the backend replay-gap control frame (never business state). */
export function parseCommandReplayGap(data: string, cursor: { epoch?: string; sequence?: number }): CommandStreamGap {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON control frames still mean "replay could not cover the gap".
  }
  const epoch = typeof payload.epoch === 'string' && payload.epoch ? payload.epoch : cursor.epoch;
  const requested = typeof payload.requestedLastEventId === 'string' ? payload.requestedLastEventId : undefined;
  const requestedCursor = requested === undefined ? undefined : parseFullCursor(requested);
  const sequence = requestedCursor?.epoch === epoch ? requestedCursor.sequence : undefined;
  return {
    ...(epoch ? { epoch } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(requested ? { cursor: requested } : {}),
  };
}

function isJsonObject(data: string): boolean {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function browserEventSourceFactory(): ((url: string) => EventSourceLike) | undefined {
  if (typeof EventSource === 'undefined') return undefined;
  return (target) => new EventSource(target) as unknown as EventSourceLike;
}

/**
 * Command-result transport backed by one FAB SSE stream (ADR-010 §2/§6.2/§6.4).
 *
 * Ownership: every consumer Stream is a child of the supplied
 * CommandTransportScope; the first commandResults consumer opens one EventSource,
 * the last consumer (or Scope close) closes it, and Scope finalizers clear every
 * timer. Each connection attempt carries a generation token: callbacks from a
 * closed/replaced connection are rejected and reported as stale-generation dirty
 * signals instead of corrupting the current connection state.
 *
 * Ordered ACK ledger (never max(sequence)):
 *  - observed: highest parsed SSE id (diagnostics/dedupe only);
 *  - delivered: highest frame accepted by the bounded consumer queue (diagnostics);
 *  - acknowledged: highest SAFE prefix — every entry up to it is applied|covered.
 * Every delivered frame with a usable id is appended to a bounded ordered ledger
 * as 'pending'; the bridge marks it 'applied' only after the actor advanced;
 * authoritative recovery calls cover(cursor) to mark entries 'covered'. The
 * acknowledged cursor advances only across a contiguous applied|covered prefix, so
 * a later applied event can never skip an earlier pending one. Ledger saturation,
 * epoch discontinuity and protocol errors become Dirty (List recovery); pending
 * entries are never evicted to move the cursor forward. Protocol diagnostics are
 * bounded and payload-free. There is no unbounded PubSub and no global runner here.
 */
export function createSseCommandEventSource(
  url: string,
  options: SseCommandEventSourceOptions,
): CommandEventSource {
  const capacity = Math.max(1, options.capacity ?? 256);
  const connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? 10_000);
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 250);
  const ackLedgerCapacity = Math.max(1, options.ackLedgerCapacity ?? DEFAULT_ACK_LEDGER_CAPACITY);
  const decoder = new MessageDecoder();
  const state: {
    status: CommandConnectionStatus;
    source: EventSourceLike | null;
    removeControlListeners?: () => void;
    opened: boolean;
    generation: number;
    observed?: CommandCursor;
    delivered?: CommandCursor;
    acknowledged?: CommandCursor;
    connectTimer?: ReturnType<typeof setTimeout>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
  } = { status: 'connecting', source: null, opened: false, generation: 0 };
  let stopped = false;
  let finalizerRegistered = false;
  let droppedTotal = 0;
  let lossEpisode: LossEpisode | undefined;

  /** Ordered delivered ledger (arrival order == Site sequence order per generation). */
  const ledger: AckLedgerEntry[] = [];
  const ledgerByEventIdentity = new Map<string, AckLedgerEntry>();
  let ledgerEpoch: string | undefined;
  /** Capacity episode: no further ACK tracking until an authoritative cover drains it. */
  let ledgerSaturated = false;
  /**
   * Sticky safety latch: once the ledger saturated, frames that were delivered but
   * never tracked must not be silently skipped by a later ACK. Only an
   * authoritative cover can release the safe prefix again (ADR-010 §6.2).
   */
  let ackBlockedUntilCover = false;
  let untrackedUnknown = false;
  let untrackedEpoch: string | undefined;
  let untrackedHighWater: number | undefined;
  let recoveryVersion = 0;
  /** One Dirty signal per stalled-prefix episode (later applied behind a pending head). */
  let prefixStallSignalled = false;

  const protocolDiagnosticLog: CommandProtocolDiagnostic[] = [];

  const eventIdentity = (event: Pick<CommandResultEvent, 'fabId' | 'commandId' | 'revision'>): string =>
    event.fabId + '\u0000' + event.commandId + '\u0000' + event.revision;
  const entryIdentity = (entry: AckLedgerEntry): string =>
    eventIdentity({ fabId: entry.fabId, commandId: entry.commandId, revision: entry.revision });

  /** Bounded, payload-free protocol diagnostics (ADR-010 §6.4). */
  const recordDiagnostic = (
    kind: CommandProtocolDiagnosticKind,
    reason: string,
    cursor?: CommandCursor,
  ): void => {
    protocolDiagnosticLog.push({
      at: Date.now(),
      kind,
      reason,
      ...(cursor ? { epoch: cursor.epoch, sequence: cursor.sequence } : {}),
    });
    while (protocolDiagnosticLog.length > MAX_PROTOCOL_DIAGNOSTICS) protocolDiagnosticLog.shift();
  };

  /**
   * Dirty signals always carry the last SAFE cursor (acknowledged), never a
   * delivered-but-unapplied position: recovery must not skip pending events.
   */
  const dirty = new BoundedSignal<CommandStreamDirty>(1, 'coalesce-newest');
  const recordUntrackedCursor = (cursor?: CommandCursor): void => {
    if (cursor === undefined) {
      untrackedUnknown = true;
      recoveryVersion += 1;
      return;
    }
    if (untrackedEpoch === undefined) {
      untrackedEpoch = cursor.epoch;
      untrackedHighWater = cursor.sequence;
      return;
    }
    if (untrackedEpoch !== cursor.epoch) {
      untrackedUnknown = true;
      recoveryVersion += 1;
      return;
    }
    untrackedHighWater = Math.max(untrackedHighWater ?? cursor.sequence, cursor.sequence);
  };
  const publishDirty = (
    reason: CommandStreamDirtyReason,
    droppedIncrement: number,
    includeEpisode: boolean,
    cursor?: CommandCursor,
  ): void => {
    ackBlockedUntilCover = true;
    recordUntrackedCursor(cursor);
    droppedTotal += droppedIncrement;
    const safe = state.acknowledged;
    const episode = includeEpisode ? lossEpisode : undefined;
    dirty.publish({
      reason,
      droppedCount: droppedTotal,
      ...(safe ? { delivered: { ...safe } } : {}),
      ...(episode ? { gapStart: episode.gapStart, gapEnd: episode.gapEnd } : {}),
    });
  };
  /**
   * Protocol-level Dirty: no gapStart (origin not provable) and no ACK advance;
   * the consumer must run authoritative List recovery (ADR-010 §6.4).
   */
  const publishProtocolDirty = (
    reason: CommandStreamDirtyReason,
    kind: CommandProtocolDiagnosticKind,
    detail: string,
    cursor?: CommandCursor,
  ): void => {
    recordDiagnostic(kind, detail, cursor);
    publishDirty(reason, 0, false, cursor);
  };
  const publishControl = <A>(channel: BoundedSignal<A>, value: A): void => {
    const outcome = channel.publish(value);
    if (outcome.dropped > 0) publishDirty('slow-consumer', outcome.dropped, false);
  };

  const commandResults = new BoundedSignal<CommandResultEvent>(capacity, 'mark-dirty');
  const gaps = new BoundedSignal<CommandStreamGap>(capacity, 'mark-dirty');
  const statuses = new BoundedSignal<CommandConnectionStatus>(capacity, 'mark-dirty');
  const failures = new BoundedSignal<CommandTransportFailure>(capacity, 'mark-dirty');
  const reconnections = new BoundedSignal<void>(capacity, 'mark-dirty');

  /** Advance the safe cursor over a contiguous applied|covered ledger prefix. */
  const drainAcknowledgedPrefix = (): void => {
    // A saturated ledger may have delivered frames without tracking them; the safe
    // prefix must not advance until an authoritative cover proves the watermark.
    if (ackBlockedUntilCover) return;
    while (ledger.length > 0) {
      const head = ledger[0];
      if (head.status === 'pending') break;
      ledger.shift();
      ledgerByEventIdentity.delete(entryIdentity(head));
      state.acknowledged = advanceSafeAcknowledged(state.acknowledged, {
        epoch: head.epoch,
        sequence: head.sequence,
      });
    }
    if (ledger.length === 0) {
      ledgerEpoch = undefined;
      ledgerSaturated = false;
      prefixStallSignalled = false;
    }
  };

  /**
   * Append one delivered frame to the ordered ledger. The entry stays 'pending'
   * until the bridge reports the actor applied it; the acknowledged cursor never
   * moves here. Capacity/epoch/non-monotonic conditions degrade to Dirty.
   */
  const appendLedgerEntry = (event: CommandResultEvent, cursor: CommandCursor): void => {
    if (ledgerSaturated || ackBlockedUntilCover) {
      recordUntrackedCursor(cursor);
      return;
    }
    const acknowledged = state.acknowledged;
    if (acknowledged && acknowledged.epoch === cursor.epoch && cursor.sequence <= acknowledged.sequence) {
      // The frame is at/before the safe prefix: already applied or covered.
      return;
    }
    const expectedEpoch = ledgerEpoch ?? acknowledged?.epoch;
    if (expectedEpoch !== undefined && cursor.epoch !== expectedEpoch) {
      publishProtocolDirty(
        'stale-generation',
        'epoch',
        'data frame epoch differs from the safe acknowledged epoch; authoritative recovery required',
        cursor,
      );
      return;
    }
    const tail = ledger[ledger.length - 1];
    if (tail && tail.epoch === cursor.epoch) {
      if (cursor.sequence === tail.sequence) return; // duplicate frame already tracked
      if (cursor.sequence < tail.sequence) {
        publishProtocolDirty('protocol-error', 'decode', 'non-monotonic SSE journal sequence', cursor);
        return;
      }
    }
    if (ledger.length >= ackLedgerCapacity) {
      // Never evict a pending entry to advance the cursor: block ACK tracking and
      // require authoritative recovery to cover the backlog (ADR-010 §6.2). The
      // latch stays until cover() even if the tracked prefix later drains, because
      // the untracked frames between them are not provably applied.
      ledgerSaturated = true;
      ackBlockedUntilCover = true;
      publishProtocolDirty(
        'ack-ledger-overflow',
        'ack-ledger',
        'ordered ACK ledger reached capacity; awaiting authoritative cover',
        cursor,
      );
      return;
    }
    ledgerEpoch = cursor.epoch;
    const entry: AckLedgerEntry = {
      epoch: cursor.epoch,
      sequence: cursor.sequence,
      fabId: event.fabId,
      commandId: event.commandId,
      revision: event.revision,
      status: 'pending',
    };
    ledger.push(entry);
    ledgerByEventIdentity.set(eventIdentity(event), entry);
  };

  const acknowledge = (event: CommandResultEvent): void => {
    const entry = ledgerByEventIdentity.get(eventIdentity(event));
    if (!entry || entry.status !== 'pending') return;
    entry.status = 'applied';
    const head = ledger[0];
    if (!prefixStallSignalled && head !== undefined && head !== entry && head.status === 'pending') {
      // A later event was applied while an earlier delivered event is not (e.g. its
      // command never got an actor). The safe prefix must not jump it: signal Dirty
      // once so the consumer covers the blocked range via authoritative recovery.
      prefixStallSignalled = true;
      publishProtocolDirty(
        'slow-consumer',
        'ack-ledger',
        'applied event blocked behind an earlier pending delivery; authoritative recovery required',
        { epoch: head.epoch, sequence: head.sequence },
      );
    }
    drainAcknowledgedPrefix();
  };

  /**
   * Authoritative recovery safe watermark (ADR-010 §6.2). Marks entries at/before
   * the cursor covered and advances the safe prefix; an authoritative epoch
   * replacement is accepted ONLY here. A late/older-generation cover must not be
   * issued by the owner (FabRuntime serializes cover per recovery generation); the
   * transport additionally never regresses the same-epoch acknowledged sequence.
   */
  const cover = (
    cursor: CommandCursor,
    expectedRecoveryVersion: number,
    kind: 'journal' | 'list',
  ): boolean => {
    if (expectedRecoveryVersion !== recoveryVersion) return false;
    if (ackBlockedUntilCover) {
      if (untrackedUnknown && kind !== 'list') return false;
      if (untrackedEpoch !== undefined && untrackedEpoch !== cursor.epoch && kind !== 'list') return false;
      if (untrackedEpoch === cursor.epoch && untrackedHighWater !== undefined && cursor.sequence < untrackedHighWater) return false;
    }
    const acknowledged = state.acknowledged;
    if (acknowledged && acknowledged.epoch !== cursor.epoch && kind !== 'list') return false;
    for (const entry of ledger) {
      if (entry.epoch !== cursor.epoch || entry.sequence <= cursor.sequence) entry.status = 'covered';
    }
    if (!acknowledged || acknowledged.epoch !== cursor.epoch || cursor.sequence > acknowledged.sequence) {
      state.acknowledged = { ...cursor };
    }
    const delivered = state.delivered;
    state.delivered = delivered && delivered.epoch === cursor.epoch
      ? (cursor.sequence > delivered.sequence ? { ...cursor } : delivered)
      : { ...cursor };
    ledgerEpoch = cursor.epoch;
    ledgerSaturated = false;
    ackBlockedUntilCover = false;
    untrackedUnknown = false;
    untrackedEpoch = undefined;
    untrackedHighWater = undefined;
    prefixStallSignalled = false;
    drainAcknowledgedPrefix();
    return true;
  };

  const recordDeliveredFrame = (event: CommandResultEvent, cursor: CommandCursor | undefined): void => {
    const outcome = commandResults.publish(event);
    if (outcome.accepted) {
      if (cursor) {
        state.delivered = advanceCursor(state.delivered, cursor);
        appendLedgerEntry(event, cursor);
      } else {
        // Cannot prove the frame identity: deliver for visibility but never ACK;
        // force authoritative List recovery (no gapStart).
        publishProtocolDirty('protocol-error', 'decode', 'command frame has no usable journal id');
      }
    }
    if (outcome.dropped > 0) {
      // The frame is lost for at least one bounded consumer. Record the exact
      // sequence range (when the id line is usable) and keep the safe cursor as the
      // recovery start; never advance delivered/acknowledged on a dropped frame.
      if (cursor) {
        lossEpisode = lossEpisode
          ? { gapStart: Math.min(lossEpisode.gapStart, cursor.sequence), gapEnd: Math.max(lossEpisode.gapEnd, cursor.sequence) }
          : { gapStart: cursor.sequence, gapEnd: cursor.sequence };
      }
      publishDirty('overflow', outcome.dropped, lossEpisode !== undefined, cursor);
      return;
    }
    if (outcome.accepted) {
      // A gap episode ends when a frame is delivered again: the next loss starts a
      // new exact range instead of growing the previous one forever.
      lossEpisode = undefined;
    }
  };

  const snapshotCursors = (): CommandSourceCursors => ({
    ...(state.observed ? { observed: { ...state.observed } } : {}),
    ...(state.delivered ? { delivered: { ...state.delivered } } : {}),
    ...(state.acknowledged ? { acknowledged: { ...state.acknowledged } } : {}),
    pendingAcknowledgements: ledger.length,
  });

  let lastStatus: CommandConnectionStatus = 'connecting';
  const publishStatus = (status: CommandConnectionStatus): void => {
    state.status = status;
    if (status === lastStatus) return;
    lastStatus = status;
    publishControl(statuses, status);
  };

  const clearConnectTimer = (): void => {
    if (state.connectTimer === undefined) return;
    clearTimeout(state.connectTimer);
    state.connectTimer = undefined;
  };
  const clearReconnectTimer = (): void => {
    if (state.reconnectTimer === undefined) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = undefined;
  };
  const clearTimers = (): void => {
    clearConnectTimer();
    clearReconnectTimer();
  };

  const closeSource = (): void => {
    const source = state.source;
    if (!source) return;
    state.source = null;
    state.generation += 1;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    state.removeControlListeners?.();
    state.removeControlListeners = undefined;
    source.close();
    clearTimers();
  };

  const closeTransport = (): void => {
    stopped = true;
    closeSource();
    state.opened = false;
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    clearReconnectTimer();
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      if (stopped || state.source || commandResults.subscriberCount === 0) return;
      open();
    }, reconnectDelayMs);
  };

  const restartConnection = (): void => {
    if (stopped) return;
    closeSource();
    scheduleReconnect();
  };

  /** Fixed, payload-free classification of a command data frame decode failure. */
  const classifyCommandFrameDecodeError = (
    cause: unknown,
  ): { readonly reason: 'decode-error' | 'protocol-error'; readonly detail: string } => {
    if (cause instanceof RealtimeDecodeError) {
      if (cause.topic !== undefined && cause.topic !== COMMAND_RESULT_TOPIC) {
        return { reason: 'protocol-error', detail: 'unknown realtime topic on the command stream' };
      }
      return { reason: 'decode-error', detail: 'invalid command result frame' };
    }
    return { reason: 'decode-error', detail: 'command frame could not be decoded' };
  };

  const open = (): void => {
    if (stopped || state.source) return;
    const generation = state.generation + 1;
    state.generation = generation;
    const factory = options.eventSourceFactory ?? browserEventSourceFactory();
    if (!factory) {
      publishStatus('failed');
      publishControl(failures, { message: 'EventSource is not available in this environment' });
      publishDirty('closed', 0, false);
      return;
    }
    let source: EventSourceLike;
    try {
      source = factory(url);
    } catch (cause) {
      publishStatus('failed');
      publishControl(failures, { message: 'command stream connection failed', cause });
      publishDirty('closed', 0, false);
      return;
    }
    state.source = source;
    if (!finalizerRegistered) {
      finalizerRegistered = true;
      options.host.addFinalizer(closeTransport);
    }
    const isCurrent = (): boolean => !stopped && state.source === source && state.generation === generation;
    const isStale = (): boolean => {
      if (isCurrent()) return false;
      recordDiagnostic('epoch', 'stale connection generation callback dropped');
      publishDirty('stale-generation', 0, false);
      return true;
    };

    const onReplayGap = (event: SseMessageLike): void => {
      if (isStale()) return;
      if (!isJsonObject(event.data)) {
        recordDiagnostic('control-frame', 'replay-gap control frame was not JSON');
      }
      publishDirty('server-overflow', 0, false);
      publishControl(gaps, parseCommandReplayGap(event.data, {}));
    };
    const onServerDirty = (event: SseMessageLike): void => {
      if (isStale()) return;
      const frame = parseServerDirty(event.data);
      if (!frame) {
        publishProtocolDirty(
          'invalid-control-frame',
          'control-frame',
          'server dirty control frame could not be decoded',
          parseFullCursor(event.lastEventId),
        );
        return;
      }
      // The frame's cursor is a server position, never our delivered position: it
      // must not advance any local cursor. droppedCount stays monotonic.
      droppedTotal = Math.max(droppedTotal, frame.droppedCount);
      publishDirty(SERVER_DIRTY_REASON[frame.reason], 0, false);
    };
    source.addEventListener?.('replay-gap', onReplayGap);
    source.addEventListener?.('dirty', onServerDirty);
    state.removeControlListeners = () => {
      source.removeEventListener?.('replay-gap', onReplayGap);
      source.removeEventListener?.('dirty', onServerDirty);
    };

    source.onopen = () => {
      if (isStale()) return;
      clearConnectTimer();
      const reopened = state.opened;
      state.opened = true;
      if (reopened) publishControl(reconnections, undefined);
      publishStatus('open');
    };
    source.onmessage = (event) => {
      if (isStale()) return;
      const cursor = parseFullCursor(event.lastEventId);
      if (cursor) state.observed = advanceCursor(state.observed, cursor);
      let decoded: DecodedRealtimeMessage;
      try {
        decoded = decoder.decode(event.data);
      } catch (cause) {
        // ADR-010 §6.4: a data frame that cannot be decoded is a correctness event,
        // never silently skipped. Publish dirty (no gapStart => authoritative List)
        // and never ACK the frame.
        const classified = classifyCommandFrameDecodeError(cause);
        publishProtocolDirty(classified.reason, 'decode', classified.detail, cursor);
        return;
      }
      if (decoded.kind !== 'command') {
        // The dedicated command stream only carries command results; another topic
        // is a protocol error and must trigger authoritative recovery.
        publishProtocolDirty('protocol-error', 'decode', 'non-command topic on the command stream', cursor);
        return;
      }
      recordDeliveredFrame(decoded.event, cursor);
    };
    source.onerror = (event) => {
      if (isStale()) return;
      publishStatus('reconnecting');
      publishControl(failures, { message: 'command stream transport error', cause: event });
      publishDirty('closed', 0, false);
      // EventSource would auto-reconnect with an unowned timer; the transport owns
      // the single connection explicitly and reopens after reconnectDelayMs. The
      // recovery start point is the safe acknowledged cursor exposed via cursors.
      restartConnection();
    };

    publishStatus('connecting');
    state.connectTimer = setTimeout(() => {
      state.connectTimer = undefined;
      if (!isCurrent()) return;
      publishStatus('failed');
      publishControl(failures, { message: 'command stream connect timeout' });
      publishDirty('closed', 0, false);
      restartConnection();
    }, connectTimeoutMs);
  };

  // Only the commandResults stream owns the connection lifetime (lazy FAB SSE):
  // status/gap/failure/reconnect streams observe an already-open connection.
  commandResults.onSubscriberChange(() => {
    if (commandResults.subscriberCount > 0) {
      if (!stopped && !state.source) open();
      return;
    }
    closeSource();
    state.opened = false;
    clearTimers();
  });
  statuses.onSubscriberChange(() => {
    if (statuses.subscriberCount === 1) publishControl(statuses, state.status);
  });

  return {
    commandResults: commandResults.stream,
    reconnected: reconnections.stream,
    gaps: gaps.stream,
    connectionStatus: statuses.stream,
    transportFailures: failures.stream,
    dirty: dirty.stream,
    acknowledge,
    get recoveryVersion(): number {
      return recoveryVersion;
    },
    cover,
    availability: 'ready',
    get protocolDiagnostics(): readonly CommandProtocolDiagnostic[] {
      return protocolDiagnosticLog.slice();
    },
    get cursors(): CommandSourceCursors {
      return snapshotCursors();
    },
  };
}
