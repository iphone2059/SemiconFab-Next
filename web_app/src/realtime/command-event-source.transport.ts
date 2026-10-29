import { Cause, Effect, Option, Queue, Schema, Stream } from 'effect';
import type {
  CommandConnectionStatus,
  CommandCursor,
  CommandEventSource,
  CommandResultEvent,
  CommandSourceCursors,
  CommandStreamDirty,
  CommandStreamDirtyReason,
  CommandStreamGap,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import { type CommandDirtyReason, commandDirtySchema } from '@/api/command-recovery.schema';
import { MessageDecoder } from '@/realtime/message-decoder';

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
}

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

/** Bounded per-consumer delivery accounting for one recorded event. */
const MAX_REMEMBERED_EVENTS = 2048;

/**
 * Server-classified dirty causes (CommandDirtyDto) mapped onto the ADR-010 §2
 * transport reasons. All of them require authoritative reconciliation, and none
 * of them may be mistaken for a delivered journal position.
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

/** Monotonic per-epoch cursor advance; a new epoch restarts the sequence order. */
function advanceCursor(current: CommandCursor | undefined, candidate: CommandCursor): CommandCursor {
  if (!current) return candidate;
  if (current.epoch === candidate.epoch) {
    return candidate.sequence >= current.sequence ? candidate : current;
  }
  // A different epoch is not comparable; the newest observed epoch wins and the
  // consumer must run authoritative recovery before trusting continuation.
  return candidate;
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
  return {
    ...(epoch ? { epoch } : {}),
    ...(cursor.sequence !== undefined ? { sequence: cursor.sequence } : {}),
    ...(requested ? { cursor: requested } : {}),
  };
}

function browserEventSourceFactory(): ((url: string) => EventSourceLike) | undefined {
  if (typeof EventSource === 'undefined') return undefined;
  return (target) => new EventSource(target) as unknown as EventSourceLike;
}

/**
 * Command-result transport backed by one FAB SSE stream (ADR-010 §2).
 *
 * Ownership: every consumer Stream is a child of the supplied
 * CommandTransportScope; the first commandResults consumer opens one EventSource,
 * the last consumer (or Scope close) closes it, and Scope finalizers clear every
 * timer. Each connection attempt carries a generation token: callbacks from a
 * closed/replaced connection are rejected and reported as stale-generation
 * dirty signals instead of corrupting the current connection state.
 *
 * Three cursors, never mixed:
 *  - observed: highest parsed SSE id (diagnostics/dedupe only);
 *  - delivered: highest frame actually accepted by the bounded consumer queue;
 *  - acknowledged: highest delivered frame the consumer applied via acknowledge().
 * A full queue drops the frame BEFORE delivered advances, records the exact
 * dropped sequence range into the dirty signal and keeps the conservative
 * delivered cursor as the authoritative recovery start point. There is no
 * unbounded PubSub and no global Effect runner here.
 */
export function createSseCommandEventSource(
  url: string,
  options: SseCommandEventSourceOptions,
): CommandEventSource {
  const capacity = Math.max(1, options.capacity ?? 256);
  const connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? 10_000);
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 250);
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
  /** Delivered event -> journal cursor, bounded; acknowledge() consumes entries. */
  const rememberedEvents = new Map<string, CommandCursor>();

  const eventKey = (event: CommandResultEvent): string =>
    event.fabId + '\u0000' + event.commandId + '\u0000' + event.revision;

  const rememberEvent = (event: CommandResultEvent, cursor: CommandCursor): void => {
    rememberedEvents.set(eventKey(event), cursor);
    if (rememberedEvents.size <= MAX_REMEMBERED_EVENTS) return;
    const oldest = rememberedEvents.keys().next().value;
    if (oldest !== undefined) rememberedEvents.delete(oldest);
  };

  /**
   * Conservative recovery start: the acknowledged cursor when it is at or before
   * delivered in the same epoch, otherwise delivered. Cursors from different
   * epochs are not comparable, so the acknowledged (older) epoch is conservative.
   */
  const conservativeDelivered = (): CommandCursor | undefined => {
    const delivered = state.delivered;
    const acknowledged = state.acknowledged;
    if (!delivered) return acknowledged;
    if (!acknowledged) return delivered;
    if (delivered.epoch !== acknowledged.epoch) return acknowledged;
    return acknowledged.sequence <= delivered.sequence ? acknowledged : delivered;
  };

  const dirty = new BoundedSignal<CommandStreamDirty>(1, 'coalesce-newest');
  /**
   * Publish a dirty signal. droppedIncrement is added to the monotonic counter;
   * the exact gap range is attached only for local bus losses (an unknown server
   * gap must omit gapStart so the consumer performs full authoritative recovery).
   */
  const publishDirty = (
    reason: CommandStreamDirtyReason,
    droppedIncrement: number,
    includeEpisode: boolean,
  ): void => {
    droppedTotal += droppedIncrement;
    const delivered = conservativeDelivered();
    const episode = includeEpisode ? lossEpisode : undefined;
    dirty.publish({
      reason,
      droppedCount: droppedTotal,
      ...(delivered ? { delivered } : {}),
      ...(episode ? { gapStart: episode.gapStart, gapEnd: episode.gapEnd } : {}),
    });
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

  const recordDeliveredFrame = (event: CommandResultEvent, cursor: CommandCursor | undefined): void => {
    const outcome = commandResults.publish(event);
    if (outcome.accepted && cursor) {
      state.delivered = advanceCursor(state.delivered, cursor);
      rememberEvent(event, cursor);
    }
    if (outcome.dropped > 0) {
      // The frame is lost for at least one bounded consumer. Record the exact
      // sequence range (when the id line is usable) and report the conservative
      // delivered cursor; never advance cursors on a dropped frame.
      if (cursor) {
        lossEpisode = lossEpisode
          ? { gapStart: Math.min(lossEpisode.gapStart, cursor.sequence), gapEnd: Math.max(lossEpisode.gapEnd, cursor.sequence) }
          : { gapStart: cursor.sequence, gapEnd: cursor.sequence };
      }
      publishDirty('overflow', outcome.dropped, lossEpisode !== undefined);
      return;
    }
    if (outcome.accepted) {
      // A gap episode ends when a frame is delivered again: the next loss starts a
      // new exact range instead of growing the previous one forever.
      lossEpisode = undefined;
    }
  };

  const acknowledge = (event: CommandResultEvent): void => {
    const key = eventKey(event);
    const cursor = rememberedEvents.get(key);
    if (!cursor) return;
    rememberedEvents.delete(key);
    state.acknowledged = advanceCursor(state.acknowledged, cursor);
  };

  const snapshotCursors = (): CommandSourceCursors => ({
    ...(state.observed ? { observed: { ...state.observed } } : {}),
    ...(state.delivered ? { delivered: { ...state.delivered } } : {}),
    ...(state.acknowledged ? { acknowledged: { ...state.acknowledged } } : {}),
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

  const open = (): void => {
    if (stopped || state.source) return;
    const generation = state.generation + 1;
    state.generation = generation;
    const factory = options.eventSourceFactory ?? browserEventSourceFactory();
    if (!factory) {
      publishStatus('failed');
      publishControl(failures, { message: 'EventSource is not available in this environment' });
      return;
    }
    let source: EventSourceLike;
    try {
      source = factory(url);
    } catch (cause) {
      publishStatus('failed');
      publishControl(failures, { message: 'command stream connection failed', cause });
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
      publishDirty('stale-generation', 0, false);
      return true;
    };

    const onReplayGap = (event: SseMessageLike): void => {
      if (isStale()) return;
      const observed = parseCommandCursor(event.lastEventId);
      publishControl(gaps, parseCommandReplayGap(event.data, observed));
    };
    const onServerDirty = (event: SseMessageLike): void => {
      if (isStale()) return;
      const frame = parseServerDirty(event.data);
      if (!frame) return;
      // The frame's cursor is a server position, never our delivered position: it
      // must not advance any local cursor. droppedCount stays monotonic.
      droppedTotal = Math.max(droppedTotal, frame.droppedCount);
      const delivered = conservativeDelivered();
      dirty.publish({
        reason: SERVER_DIRTY_REASON[frame.reason],
        droppedCount: droppedTotal,
        ...(delivered ? { delivered } : {}),
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
      const reopened = state.opened;
      state.opened = true;
      if (reopened) publishControl(reconnections, undefined);
      publishStatus('open');
    };
    source.onmessage = (event) => {
      if (isStale()) return;
      const cursor = parseFullCursor(event.lastEventId);
      if (cursor) state.observed = advanceCursor(state.observed, cursor);
      try {
        const decoded = decoder.decode(event.data);
        if (decoded.kind === 'command') recordDeliveredFrame(decoded.event, cursor);
      } catch {
        // Malformed frames are transport noise; authoritative reconciliation
        // recovers the command state instead of guessing from the frame.
      }
    };
    source.onerror = (event) => {
      if (isStale()) return;
      publishStatus('reconnecting');
      publishControl(failures, { message: 'command stream transport error', cause: event });
      // EventSource would auto-reconnect with an unowned timer; the transport owns
      // the single connection explicitly and reopens after reconnectDelayMs. The
      // recovery start point is the acknowledged cursor exposed via cursors.
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
    get cursors(): CommandSourceCursors {
      return snapshotCursors();
    },
  };
}
