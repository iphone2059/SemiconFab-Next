import { Cause, Effect, Option, Queue, Schema, Stream } from 'effect';
import type {
  CommandConnectionStatus,
  CommandCoverAuthority,
  CommandCursor,
  CommandEventSource,
  CommandProtocolDiagnostic,
  CommandProtocolDiagnosticKind,
  CommandResultEvent,
  CommandSourceAvailability,
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
import { resolveIntegerOption, resolveTimeoutOption } from '@/contracts/command-config';

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
  /** Per-signal bounded buffer capacity (ADR-007 §5 target: 256); strict validated (R4-07). */
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
  /**
   * Bounded number of consecutive failed open attempts (factory throw, error before
   * open, connect timeout) before the transport declares itself permanently
   * unavailable (R4-06). A successful onopen resets the counter (default 4).
   */
  readonly maxConnectAttempts?: number;
}

export const DEFAULT_ACK_LEDGER_CAPACITY = 256;
export const DEFAULT_MAX_CONNECT_ATTEMPTS = 4;
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
 * One untrusted/lost position recorded by the unified R4-01 ACK latch. Every loss
 * path funnels through markUntrustedGap so no path can publish a Dirty signal
 * without also blocking the acknowledged cursor until an authoritative cover
 * proves the untracked range.
 */
interface UntrustedGapInput {
  readonly reason: CommandStreamDirtyReason;
  readonly kind: CommandProtocolDiagnosticKind;
  readonly detail: string;
  /** Last observed frame position; diagnostics only. */
  readonly cursor?: CommandCursor;
  /**
   * Proven journal position of a frame that was delivered but not appended to the
   * ledger (or lost before tracking). Absent means the position cannot be proven.
   */
  readonly untracked?: CommandCursor;
  /** Bounded-bus drops attributed to this loss (monotonic droppedCount). */
  readonly droppedIncrement?: number;
  readonly includeLossEpisode?: boolean;
  /**
   * false when the path already publishes its own dedicated signal (gap / failure);
   * the latch still engages and a bounded diagnostic is still recorded.
   */
  readonly publishDirtySignal?: boolean;
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

/**
 * Parse the backend replay-gap control frame (never business state).
 *
 * R4-04: an SSE control frame has no id: line, so `event.lastEventId` is the id of
 * the *previous* data frame (possibly from an old epoch) and is never a cursor for
 * this gap. Only the payload's own epoch is accepted here; `requestedLastEventId`
 * is carried as a diagnostics-only cursor string. The parser must never manufacture
 * a usable sequence: the runtime forces List-only recovery for every replay-gap,
 * and combining the payload epoch with an inherited sequence would skip events.
 */
export function parseCommandReplayGap(data: string): CommandStreamGap {
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A non-JSON control frame still means "replay could not cover the disconnect";
    // with no provable position the caller must run List-only recovery.
  }
  const epoch = typeof payload?.epoch === 'string' && payload.epoch.length > 0 ? payload.epoch : undefined;
  const requested = typeof payload?.requestedLastEventId === 'string' && payload.requestedLastEventId.length > 0
    ? payload.requestedLastEventId
    : undefined;
  return {
    ...(epoch !== undefined ? { epoch } : {}),
    ...(requested !== undefined ? { cursor: requested } : {}),
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
 * timer. A transport that has not opened is 'closed' (normal idle); open()
 * publishes 'connecting', onopen 'open', onerror/transient attempt failure
 * 'reconnecting', a deliberate close 'closed' and only permanent unavailability
 * 'failed' (Round 5.1 / P2-01). Each connection attempt carries a generation token: callbacks from a
 * closed/replaced connection are rejected and reported as stale-generation dirty
 * signals instead of corrupting the current connection state.
 *
 * Ordered ACK ledger (never max(sequence)):
 *  - observed: highest parsed SSE id (diagnostics/dedupe only);
 *  - delivered: highest frame accepted by the bounded consumer queue (diagnostics);
 *  - acknowledged: highest SAFE prefix — every entry up to it is applied|covered.
 * Every delivered frame with a usable id is appended to a bounded ordered ledger
 * as 'pending'; the bridge marks it 'applied' only after the actor advanced;
 * authoritative recovery calls cover(cursor, authority) to mark entries 'covered'.
 * The acknowledged cursor advances only across a contiguous applied|covered prefix,
 * so a later applied event can never skip an earlier pending one. Ledger saturation,
 * epoch discontinuity and protocol errors become Dirty (List recovery); pending
 * entries are never evicted to move the cursor forward.
 *
 * R4-01: every loss path (consumer queue drop, unprovable frame id, decode/protocol
 * failure, server dirty, replay-gap, transport error) engages one unified sticky
 * ACK latch and records the untracked journal position (or marks the position
 * unknown). A cover releases it only when the authoritative watermark provably
 * covers every known untracked position; a cover below the high water — or a
 * journal cover for an unknown/cross-epoch position — keeps the latch and
 * publishes `uncovered-gap` (no gapStart => consumer retries the authoritative List).
 *
 * R4-06: `availability` becomes `unavailable` permanently when the environment has
 * no EventSource factory or after a bounded number of failed open attempts; no
 * reconnect loop is started after that. Protocol diagnostics are bounded and
 * payload-free. There is no unbounded PubSub and no global runner here.
 */
export function createSseCommandEventSource(
  url: string,
  options: SseCommandEventSourceOptions,
): CommandEventSource {
  // R4-07: explicit bounds are validated at construction; a silent Math.max
  // fallback would turn NaN/Infinity into "no bound" instead of failing fast.
  const capacity = resolveIntegerOption('capacity', options.capacity, 256, { min: 1 });
  const connectTimeoutMs = resolveTimeoutOption('connectTimeoutMs', options.connectTimeoutMs, 10_000, { min: 1 });
  const reconnectDelayMs = resolveTimeoutOption('reconnectDelayMs', options.reconnectDelayMs, 250, { min: 0 });
  const ackLedgerCapacity = resolveIntegerOption(
    'ackLedgerCapacity',
    options.ackLedgerCapacity,
    DEFAULT_ACK_LEDGER_CAPACITY,
    { min: 1 },
  );
  const maxConnectAttempts = resolveIntegerOption(
    'maxConnectAttempts',
    options.maxConnectAttempts,
    DEFAULT_MAX_CONNECT_ATTEMPTS,
    { min: 1, max: 64 },
  );
  /**
   * Resolved once: an environment without EventSource can never become ready
   * (R4-06), so availability is knowable before the lazy connection is opened.
   */
  const eventSourceFactory = options.eventSourceFactory ?? browserEventSourceFactory();
  const decoder = new MessageDecoder();
  /**
   * Round 5.1 / P2-01 lifecycle: a transport that has not opened yet is 'closed'
   * (normal idle — it is not trying to connect and it is not failed). An
   * environment without an EventSource factory is knowable at construction and is
   * permanently unavailable immediately, so it starts 'failed' without waiting for
   * a consumer (same meaning as the pending source).
   */
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
  } = {
    status: eventSourceFactory === undefined ? 'failed' : 'closed',
    source: null,
    opened: false,
    generation: 0,
  };
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
   * R4-01 sticky safety latch: once any loss path was observed, frames that were
   * delivered but never tracked must not be silently skipped by a later ACK/Cover.
   * Only an authoritative cover that provably covers every untracked position can
   * release the safe prefix again (ADR-010 §6.2).
   */
  let ackBlockedUntilCover = false;
  /**
   * R4-01 untracked positions. untrackedHighWater is the highest journal position
   * known to have been delivered without an ACK-ledger entry (consumer queue drop,
   * no ledger capacity, or a latched frame); untrustedUnknownGap records that at
   * least one untracked position cannot be proven at all. Both survive until a
   * covering authoritative watermark; a cover below the high water (or a journal
   * cover for an unknown/cross-epoch position) must never release the latch.
   */
  let untrackedHighWater: CommandCursor | undefined;
  let untrustedUnknownGap = false;
  let lossGeneration = 0;
  /** One Dirty signal per stalled-prefix episode (later applied behind a pending head). */
  let prefixStallSignalled = false;

  // R4-06a availability: permanently unavailable when the environment has no
  // EventSource factory (now) or after bounded failed open attempts (later).
  let sourceAvailability: CommandSourceAvailability = eventSourceFactory === undefined ? 'unavailable' : 'ready';
  let permanentlyUnavailable = eventSourceFactory === undefined;
  let unavailableSignalled = false;
  /** Consecutive failed open attempts; reset by a successful onopen (R4-06). */
  let failedOpenAttempts = 0;
  /** True once the current attempt reached onopen (a later error is a disconnect, not a failed open). */
  let currentAttemptOpened = false;

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
  const publishDirty = (
    reason: CommandStreamDirtyReason,
    droppedIncrement: number,
    includeEpisode: boolean,
  ): void => {
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
    publishDirty(reason, 0, false);
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

  /** Record one delivered-but-untracked position; cross-epoch positions cannot be ordered. */
  const recordUntrackedPosition = (cursor: CommandCursor): void => {
    lossGeneration += 1;
    const highWater = untrackedHighWater;
    if (highWater === undefined) {
      untrackedHighWater = { epoch: cursor.epoch, sequence: cursor.sequence };
      return;
    }
    if (highWater.epoch !== cursor.epoch) {
      // Server epochs are opaque/not orderable: only an authoritative List snapshot
      // can supersede an untracked position from another epoch.
      untrustedUnknownGap = true;
      untrackedHighWater = { epoch: cursor.epoch, sequence: cursor.sequence };
      return;
    }
    if (cursor.sequence > highWater.sequence) {
      untrackedHighWater = { epoch: cursor.epoch, sequence: cursor.sequence };
    }
  };

  /**
   * R4-01 unified loss path: engage the sticky ACK latch, record the untracked
   * position (or mark it unknown), keep a bounded payload-free diagnostic and — for
   * paths without a dedicated signal — publish the Dirty that forces authoritative
   * recovery.
   */
  const markUntrustedGap = (input: UntrustedGapInput): void => {
    ackBlockedUntilCover = true;
    if (input.untracked !== undefined) recordUntrackedPosition(input.untracked);
    else {
      lossGeneration += 1;
      untrustedUnknownGap = true;
    }
    recordDiagnostic(input.kind, input.detail, input.cursor ?? input.untracked);
    if (input.publishDirtySignal === false) return;
    publishDirty(input.reason, input.droppedIncrement ?? 0, input.includeLossEpisode === true);
  };

  /**
   * Advance the safe cursor over a contiguous applied|covered ledger prefix. The
   * tracked prefix is always provably applied/covered, so it may drain up to (never
   * past) the untracked latch position; the latch itself only cover() can release.
   */
  const drainAcknowledgedPrefix = (): void => {
    if (ackBlockedUntilCover || ledgerSaturated) return;
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
      if (!ackBlockedUntilCover) {
        ledgerSaturated = false;
        prefixStallSignalled = false;
      }
    }
  };

  /**
   * Append one delivered frame to the ordered ledger. The entry stays 'pending'
   * until the bridge reports the actor applied it; the acknowledged cursor never
   * moves here. Capacity/epoch/non-monotonic conditions degrade to Dirty + latch.
   */
  const appendLedgerEntry = (event: CommandResultEvent, cursor: CommandCursor): void => {
    const acknowledged = state.acknowledged;
    if (acknowledged && acknowledged.epoch === cursor.epoch && cursor.sequence <= acknowledged.sequence) {
      // The frame is at/before the safe prefix: already applied or covered.
      return;
    }
    const expectedEpoch = ledgerEpoch ?? acknowledged?.epoch;
    if (expectedEpoch !== undefined && cursor.epoch !== expectedEpoch) {
      markUntrustedGap({
        reason: 'stale-generation',
        kind: 'epoch',
        detail: 'data frame epoch differs from the safe acknowledged epoch; authoritative recovery required',
        cursor,
        untracked: cursor,
      });
      return;
    }
    const tail = ledger[ledger.length - 1];
    if (tail && tail.epoch === cursor.epoch) {
      if (cursor.sequence === tail.sequence) return; // duplicate frame already tracked
      if (cursor.sequence < tail.sequence) {
        markUntrustedGap({
          reason: 'protocol-error',
          kind: 'decode',
          detail: 'non-monotonic SSE journal sequence',
          cursor,
          untracked: cursor,
        });
        return;
      }
    }
    if (ledger.length >= ackLedgerCapacity) {
      // Never evict a pending entry to advance the cursor: block ACK tracking and
      // require authoritative recovery to cover the backlog (ADR-010 §6.2). The
      // frame itself is delivered but untracked, so it becomes the high water.
      ledgerSaturated = true;
      markUntrustedGap({
        reason: 'ack-ledger-overflow',
        kind: 'ack-ledger',
        detail: 'ordered ACK ledger reached capacity; awaiting authoritative cover',
        cursor,
        untracked: cursor,
      });
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
   * R4-01 latch release decision. A cover releases the latch only when it provably
   * covers every known untracked position:
   *  - a known position must be in the same epoch and cursor.sequence >= high water;
   *  - a position from another epoch, or an unknown position, additionally requires
   *    the authoritative List authority (a journal loop cannot prove them).
   */
  const coverCoversLatch = (cursor: CommandCursor, authority: CommandCoverAuthority): boolean => {
    const highWater = untrackedHighWater;
    if (highWater !== undefined) {
      if (cursor.epoch === highWater.epoch) {
        if (cursor.sequence < highWater.sequence) return false;
      } else if (authority !== 'list') {
        return false;
      }
    }
    if (untrustedUnknownGap && authority !== 'list') return false;
    return true;
  };

  /**
   * Authoritative recovery safe watermark (ADR-010 §6.2 / R4-01). Marks ledger
   * entries at/before the cursor covered and advances the acknowledged watermark
   * conservatively; an authoritative epoch replacement is accepted ONLY here. The
   * ACK latch is released only by a cover that proves the untracked range; an
   * insufficient cover keeps the latch and publishes `uncovered-gap` so the
   * consumer retries the authoritative List. A same-epoch acknowledged sequence
   * never regresses.
   *
   * Round 5.1 / P1-04: a cover only marks ledger entries covered, advances the
   * acknowledged safe cursor, replaces ledgerEpoch and may release a proven ACK
   * latch. It must never modify `delivered` (or `observed`): delivered is the
   * last frame actually published to a bounded consumer, so a cross-epoch List
   * cover leaves it in the old epoch until a real frame of the new epoch arrives.
   */
  const cover = (cursor: CommandCursor, authority: CommandCoverAuthority = 'journal', lossBarrier?: number) => {
    const previousEpoch = state.acknowledged?.epoch ?? ledgerEpoch;
    const epochReplaced = previousEpoch !== undefined && previousEpoch !== cursor.epoch;
    const blocked = ackBlockedUntilCover || ledgerSaturated;
    if (typeof cursor.epoch !== 'string' || cursor.epoch.length === 0 || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 ||
      (epochReplaced && authority !== 'list') ||
      (blocked && (lossBarrier === undefined || lossBarrier !== lossGeneration || !coverCoversLatch(cursor, authority)))) {
      const reason = 'authoritative cover does not cover the untrusted gap or epoch; authoritative List required';
      recordDiagnostic('ack-ledger', reason, cursor);
      publishDirty('uncovered-gap', 0, false);
      return { status: 'insufficient' as const, cursor: { ...cursor }, authority, latchReleased: false as const, reason, recovery: 'list' as const };
    }
    // 1) Apply authoritative coverage to the ordered ledger. Pending entries are
    //    never evicted, only proven covered; an epoch replacement supersedes the
    //    old ledger entirely (its positions are not comparable).
    if (epochReplaced) {
      ledger.length = 0;
      ledgerByEventIdentity.clear();
      prefixStallSignalled = false;
    } else {
      for (const entry of ledger) {
        if (entry.epoch === cursor.epoch && entry.sequence <= cursor.sequence) entry.status = 'covered';
      }
    }
    ledgerEpoch = cursor.epoch;
    // 2) The authoritative watermark itself is safe: advance it even while the
    //    latch remains engaged (never past an untracked position, see cover check).
    const acknowledged = state.acknowledged;
    if (!acknowledged || epochReplaced) {
      state.acknowledged = { ...cursor };
    } else if (acknowledged.epoch === cursor.epoch && cursor.sequence > acknowledged.sequence) {
      state.acknowledged = { ...cursor };
    }
    // Round 5.1 / P1-04: a cover NEVER advances `delivered`. `delivered` means
    // "actually published to a bounded consumer" and only a real SSE delivery may
    // move it — a cover (especially a cross-epoch List watermark) is not a frame.
    // 3) Release the latch only when the authoritative watermark covers the
    //    untracked range; otherwise keep it sticky and force another List pass.
    if (blocked) {
      ackBlockedUntilCover = false;
      ledgerSaturated = false;
      untrackedHighWater = undefined;
      untrustedUnknownGap = false;
      prefixStallSignalled = false;
    }
    drainAcknowledgedPrefix();
    return { status: 'covered' as const, cursor: { ...cursor }, authority, latchReleased: blocked };
  };

  const recordDeliveredFrame = (event: CommandResultEvent, cursor: CommandCursor | undefined): void => {
    const outcome = commandResults.publish(event);
    if (outcome.accepted) {
      if (cursor) {
        state.delivered = advanceCursor(state.delivered, cursor);
        if (ackBlockedUntilCover || ledgerSaturated) {
          // R4-01: the latch is engaged, so this accepted frame is deliberately not
          // appended to the ledger. Record its position so a later cover below it
          // cannot release the latch and skip the frame (snapshot 200 vs frame 201).
          recordUntrackedPosition(cursor);
        } else {
          appendLedgerEntry(event, cursor);
        }
      } else {
        // Cannot prove the frame identity: deliver for visibility but never ACK;
        // force authoritative List recovery (no gapStart).
        markUntrustedGap({
          reason: 'protocol-error',
          kind: 'decode',
          detail: 'command frame has no usable journal id',
        });
      }
    }
    if (outcome.dropped > 0) {
      // The frame is lost for at least one bounded consumer. Record the exact
      // sequence range (when the id line is usable) and keep the safe cursor as the
      // recovery start; never advance acknowledged on a dropped frame.
      if (cursor) {
        lossEpisode = lossEpisode
          ? { gapStart: Math.min(lossEpisode.gapStart, cursor.sequence), gapEnd: Math.max(lossEpisode.gapEnd, cursor.sequence) }
          : { gapStart: cursor.sequence, gapEnd: cursor.sequence };
      }
      markUntrustedGap({
        reason: 'overflow',
        kind: 'ack-ledger',
        detail: 'command frame dropped by a bounded consumer queue',
        ...(cursor ? { cursor, untracked: cursor } : {}),
        droppedIncrement: outcome.dropped,
        includeLossEpisode: lossEpisode !== undefined,
      });
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

  /**
   * Lifecycle publication (Round 5.1 / P2-01). Every transition is published on the
   * bounded connectionStatus stream (never only stored in state); consecutive
   * duplicates are suppressed so 'failed' is published exactly once. `lastStatus`
   * starts at the initial lifecycle state so a first status subscriber observes the
   * current state (onSubscriberChange replay) and then the next real transition.
   */
  let lastStatus: CommandConnectionStatus = state.status;
  const publishStatus = (status: CommandConnectionStatus): void => {
    state.status = status;
    if (status === lastStatus) return;
    lastStatus = status;
    publishControl(statuses, status);
  };

  /**
   * Deliberate close: publish the normal idle lifecycle. A permanently unavailable
   * transport keeps 'failed' — it must never be downgraded to 'closed'.
   */
  const publishClosed = (): void => {
    if (permanentlyUnavailable) return;
    publishStatus('closed');
  };

  /**
   * R4-06a permanent unavailability: publish Dirty + failed status + a bounded
   * payload-free diagnostic exactly once and never schedule another retry.
   */
  const publishTransportUnavailable = (detail: string): void => {
    permanentlyUnavailable = true;
    sourceAvailability = 'unavailable';
    publishStatus('failed');
    if (unavailableSignalled) return;
    unavailableSignalled = true;
    publishControl(failures, { message: 'command transport unavailable: ' + detail });
    recordDiagnostic('epoch', 'command transport permanently unavailable: ' + detail);
    publishDirty('transport-unavailable', 0, false);
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

  /**
   * Tear the current EventSource down without deciding the lifecycle. Deliberate
   * close paths publish 'closed' explicitly; an interrupted attempt has already
   * published 'reconnecting' (or the permanent 'failed') and must not emit a
   * spurious 'closed' before the retry's 'connecting'.
   */
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

  /** Scope finalizer (ADR-007 §2/§5): closing the owned connection updates the lifecycle. */
  const closeTransport = (): void => {
    stopped = true;
    closeSource();
    state.opened = false;
    publishClosed();
  };

  const scheduleReconnect = (): void => {
    if (stopped || permanentlyUnavailable) return;
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
    if (eventSourceFactory === undefined) {
      // R4-06a: no EventSource factory can never recover; publish the permanent
      // unavailability once and never schedule a pointless reconnect loop.
      publishTransportUnavailable('EventSource is not available in this environment');
      return;
    }
    if (permanentlyUnavailable) return;
    // P2-01: an attempt is in progress. Publish 'connecting' BEFORE the factory
    // call / timer setup so the lifecycle never jumps from 'closed' straight to
    // 'open' and every attempt (including a retry) is observable.
    publishStatus('connecting');
    const generation = state.generation + 1;
    state.generation = generation;
    if (!finalizerRegistered) {
      // The transport now owns timers/sockets, so register the Scope finalizer on
      // the first open attempt (a factory throw must not leak reconnect timers).
      finalizerRegistered = true;
      options.host.addFinalizer(closeTransport);
    }
    currentAttemptOpened = false;
    let source: EventSourceLike;
    try {
      source = eventSourceFactory(url);
    } catch (cause) {
      failedOpenAttempts += 1;
      markUntrustedGap({
        reason: 'closed',
        kind: 'epoch',
        detail: 'command stream connection failed',
        publishDirtySignal: false,
      });
      publishControl(failures, { message: 'command stream connection failed', cause });
      if (failedOpenAttempts >= maxConnectAttempts) {
        publishTransportUnavailable('command stream could not be opened after ' + failedOpenAttempts + ' failed attempts');
        return;
      }
      // A transient failed attempt schedules a retry: the lifecycle is
      // 'reconnecting' (an interrupted attempt with a scheduled retry), never the
      // permanent 'failed' (P2-01).
      publishStatus('reconnecting');
      scheduleReconnect();
      return;
    }
    state.source = source;
    const isCurrent = (): boolean => !stopped && state.source === source && state.generation === generation;
    const isStale = (): boolean => {
      if (isCurrent()) return false;
      markUntrustedGap({
        reason: 'stale-generation',
        kind: 'epoch',
        detail: 'stale connection generation callback dropped',
        publishDirtySignal: true,
      });
      return true;
    };

    const onReplayGap = (event: SseMessageLike): void => {
      if (isStale()) return;
      const payloadIsObject = isJsonObject(event.data);
      const gap = parseCommandReplayGap(event.data);
      if (!payloadIsObject) {
        recordDiagnostic('control-frame', 'replay-gap control frame was not JSON');
      } else if (gap.epoch === undefined) {
        recordDiagnostic('control-frame', 'replay-gap control frame did not carry a journal epoch');
      }
      // R4-01/R4-04: the control frame has no id: line, so the inherited
      // event.lastEventId is the previous data frame's id (possibly an old epoch);
      // the gap position is unprovable, so only an authoritative List cover may
      // release the latch. The dedicated gap signal is the observable.
      markUntrustedGap({
        reason: 'protocol-error',
        kind: 'control-frame',
        detail: 'replay-gap control frame: replay could not cover the disconnect',
        publishDirtySignal: false,
      });
      publishControl(gaps, gap);
    };
    const onServerDirty = (event: SseMessageLike): void => {
      if (isStale()) return;
      const frame = parseServerDirty(event.data);
      if (!frame) {
        markUntrustedGap({
          reason: 'invalid-control-frame',
          kind: 'control-frame',
          detail: 'server dirty control frame could not be decoded',
        });
        return;
      }
      // The frame's cursor is a server position, never our delivered position: it
      // must not advance any local cursor. droppedCount stays monotonic.
      droppedTotal = Math.max(droppedTotal, frame.droppedCount);
      const safe = state.acknowledged;
      dirty.publish({
        reason: SERVER_DIRTY_REASON[frame.reason],
        droppedCount: droppedTotal,
        ...(safe ? { delivered: { ...safe } } : {}),
      });
      // R4-01: server-classified loss means events may be missing and the server
      // reported position is not a client cursor; latch with an unknown position and
      // require authoritative recovery (the dedicated dirty signal is already sent).
      markUntrustedGap({
        reason: SERVER_DIRTY_REASON[frame.reason],
        kind: 'control-frame',
        detail: 'server-classified command loss; authoritative recovery required',
        publishDirtySignal: false,
      });
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
      failedOpenAttempts = 0;
      currentAttemptOpened = true;
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
        // never silently skipped. When the id line is usable the exact journal
        // position becomes the untracked high water; otherwise the position is
        // unknown and only authoritative List recovery can prove it.
        const classified = classifyCommandFrameDecodeError(cause);
        markUntrustedGap({
          reason: classified.reason,
          kind: 'decode',
          detail: classified.detail,
          ...(cursor ? { cursor, untracked: cursor } : {}),
        });
        return;
      }
      if (decoded.kind !== 'command') {
        // The dedicated command stream only carries command results; another topic
        // is a protocol error and must trigger authoritative recovery.
        markUntrustedGap({
          reason: 'protocol-error',
          kind: 'decode',
          detail: 'non-command topic on the command stream',
          ...(cursor ? { cursor, untracked: cursor } : {}),
        });
        return;
      }
      recordDeliveredFrame(decoded.event, cursor);
    };
    source.onerror = (event) => {
      if (isStale()) return;
      publishControl(failures, { message: 'command stream transport error', cause: event });
      // R4-01: an interrupted stream can lose frames before they were tracked; the
      // position is unprovable, so the latch needs an authoritative List to release.
      markUntrustedGap({
        reason: 'closed',
        kind: 'epoch',
        detail: 'command stream transport error',
        publishDirtySignal: false,
      });
      if (!currentAttemptOpened) failedOpenAttempts += 1;
      if (failedOpenAttempts >= maxConnectAttempts) {
        publishTransportUnavailable('command stream could not be opened after ' + failedOpenAttempts + ' failed attempts');
        closeSource();
        state.opened = false;
        return;
      }
      // The connection was interrupted and a retry is scheduled (P2-01).
      publishStatus('reconnecting');
      // EventSource would auto-reconnect with an unowned timer; the transport owns
      // the single connection explicitly and reopens after reconnectDelayMs.
      restartConnection();
    };

    state.connectTimer = setTimeout(() => {
      state.connectTimer = undefined;
      if (!isCurrent()) return;
      currentAttemptOpened = false;
      failedOpenAttempts += 1;
      publishControl(failures, { message: 'command stream connect timeout' });
      markUntrustedGap({
        reason: 'closed',
        kind: 'epoch',
        detail: 'command stream connect timeout',
      });
      if (failedOpenAttempts >= maxConnectAttempts) {
        publishTransportUnavailable('command stream connect timed out after ' + failedOpenAttempts + ' failed attempts');
        closeSource();
        state.opened = false;
        return;
      }
      // A connect timeout is a transient attempt failure with a scheduled retry:
      // 'reconnecting', never the permanent 'failed' (P2-01).
      publishStatus('reconnecting');
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
    // The last consumer left: the connection is deliberately closed (normal idle),
    // never silently left 'open' and never downgraded over the permanent 'failed'.
    closeSource();
    state.opened = false;
    clearTimers();
    publishClosed();
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
    cover,
    get lossGeneration(): number {
      return lossGeneration;
    },
    get availability(): CommandSourceAvailability {
      return sourceAvailability;
    },
    get protocolDiagnostics(): readonly CommandProtocolDiagnostic[] {
      return protocolDiagnosticLog.slice();
    },
    get cursors(): CommandSourceCursors {
      return snapshotCursors();
    },
  };
}
