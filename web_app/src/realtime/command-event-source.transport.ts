import { Cause, Effect, Option, Queue, Schema, Stream } from 'effect';
import type {
  CommandConnectionStatus,
  CommandEventSource,
  CommandResultEvent,
  CommandStreamDirty,
  CommandStreamDirtyReason,
  CommandStreamGap,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import { type CommandDirtyReason, commandDirtySchema } from '@/api/command-recovery.schema';
import { MessageDecoder } from '@/realtime/message-decoder';

interface SseMessageLike {
  readonly data: string;
  /** SSE `id:` line; the command journal writes `{epoch}:{sequence}`. */
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

interface CommandCursor {
  epoch?: string;
  sequence?: number;
}

type BufferPolicy = 'mark-dirty' | 'coalesce-newest';

/**
 * Server-classified dirty causes (CommandDirtyDto) mapped onto the frozen transport
 * dirty-reason contract of ADR-007 §5. All three require authoritative reconciliation.
 */
const SERVER_DIRTY_REASON: Record<CommandDirtyReason, CommandStreamDirtyReason> = {
  'retention-trim': 'overflow',
  'epoch-replaced': 'stale-generation',
  'store-fault': 'closed',
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

/**
 * One bounded signal channel. Values are published synchronously from the
 * EventSource callbacks into per-consumer Stream.callback queues.
 *
 * - `mark-dirty`: a full consumer queue means the frame cannot be delivered, so
 *   the drop is counted and reported through the dirty channel (never silent);
 * - `coalesce-newest`: the channel is a dirty signal itself; the newest dirty
 *   state must survive, so the sliding queue keeps it and the monotonic
 *   droppedCount carries the loss accounting.
 */
class BoundedSignal<A> {
  private readonly queues = new Set<Queue.Queue<A, Cause.Done>>();
  private subscriberListener?: () => void;
  readonly stream: Stream.Stream<A>;

  constructor(
    private readonly capacity: number,
    private readonly policy: BufferPolicy,
    private readonly onOverflow: (dropped: number) => void,
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

  publish(value: A): void {
    let dropped = 0;
    for (const queue of this.queues) {
      if (this.policy === 'mark-dirty' && Queue.sizeUnsafe(queue) >= this.capacity) {
        dropped += 1;
        continue;
      }
      Queue.offerUnsafe(queue, value);
    }
    if (dropped > 0) this.onOverflow(dropped);
  }

  get subscriberCount(): number {
    return this.queues.size;
  }
}

/** Parse the journal cursor written in the SSE `id` line: `{epoch}:{sequence}`. */
export function parseCommandCursor(lastEventId: string | undefined): CommandCursor {
  if (!lastEventId) return {};
  const separator = lastEventId.lastIndexOf(':');
  if (separator <= 0) return {};
  const epoch = lastEventId.slice(0, separator);
  const rawSequence = lastEventId.slice(separator + 1);
  if (!/^\d+$/.test(rawSequence)) return { epoch };
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? { epoch, sequence } : { epoch };
}

/** Tolerant parse of the backend replay-gap control frame (never business state). */
export function parseCommandReplayGap(data: string, cursor: CommandCursor): CommandStreamGap {
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
 * Command-result transport backed by one FAB SSE stream.
 *
 * Ownership (ADR-007 §5): every consumer Stream is a child of the supplied
 * CommandTransportScope; the first commandResults consumer opens one EventSource,
 * the last consumer (or Scope close) closes it, and Scope finalizers clear every
 * timer. Each connection attempt carries a generation token: callbacks from a
 * closed/replaced connection are dropped and reported as `stale-generation`
 * dirty signals instead of corrupting the current connection state.
 *
 * Bounded memory (capacity 256 by default) without silent loss: a full consumer
 * buffer drops the frame, increments the monotonic dropped counter and publishes
 * a dirty signal on its own coalescing channel. FabRuntime turns every dirty
 * signal into authoritative reconciliation through the FAB scheduler. There is no
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
    cursor: CommandCursor;
    connectTimer?: ReturnType<typeof setTimeout>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
  } = { status: 'connecting', source: null, opened: false, generation: 0, cursor: {} };
  let stopped = false;
  let finalizerRegistered = false;
  let droppedTotal = 0;

  const observeCursor = (lastEventId: string | undefined): void => {
    const observed = parseCommandCursor(lastEventId);
    if (observed.epoch !== undefined) state.cursor.epoch = observed.epoch;
    if (observed.sequence !== undefined) state.cursor.sequence = observed.sequence;
  };

  const dirty = new BoundedSignal<CommandStreamDirty>(1, 'coalesce-newest', () => {
    /* The dirty channel is the loss record itself: coalescing keeps the newest
       state and the monotonic droppedCount preserves the total. */
  });
  const emitDirty = (reason: CommandStreamDirtyReason, dropped: number): void => {
    droppedTotal += dropped;
    dirty.publish({
      reason,
      droppedCount: droppedTotal,
      ...(state.cursor.epoch !== undefined ? { epoch: state.cursor.epoch } : {}),
      ...(state.cursor.sequence !== undefined ? { sequence: state.cursor.sequence } : {}),
    });
  };
  const overflow = (dropped: number): void => emitDirty('overflow', dropped);

  const commandResults = new BoundedSignal<CommandResultEvent>(capacity, 'mark-dirty', overflow);
  const gaps = new BoundedSignal<CommandStreamGap>(capacity, 'mark-dirty', overflow);
  const statuses = new BoundedSignal<CommandConnectionStatus>(capacity, 'mark-dirty', overflow);
  const failures = new BoundedSignal<CommandTransportFailure>(capacity, 'mark-dirty', overflow);
  const reconnections = new BoundedSignal<void>(capacity, 'mark-dirty', overflow);

  let lastStatus: CommandConnectionStatus = 'connecting';
  const publishStatus = (status: CommandConnectionStatus): void => {
    state.status = status;
    if (status === lastStatus) return;
    lastStatus = status;
    statuses.publish(status);
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
      failures.publish({ message: 'EventSource is not available in this environment' });
      return;
    }
    let source: EventSourceLike;
    try {
      source = factory(url);
    } catch (cause) {
      publishStatus('failed');
      failures.publish({ message: 'command stream connection failed', cause });
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
      emitDirty('stale-generation', 1);
      return true;
    };

    const onReplayGap = (event: SseMessageLike): void => {
      if (isStale()) return;
      observeCursor(event.lastEventId);
      gaps.publish(parseCommandReplayGap(event.data, { ...state.cursor }));
    };
    const onServerDirty = (event: SseMessageLike): void => {
      if (isStale()) return;
      const dirtyFrame = parseServerDirty(event.data);
      if (!dirtyFrame) return;
      state.cursor = { epoch: dirtyFrame.epoch, sequence: dirtyFrame.sequence };
      emitDirty(SERVER_DIRTY_REASON[dirtyFrame.reason], dirtyFrame.droppedCount);
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
      if (reopened) reconnections.publish(undefined);
      publishStatus('open');
    };
    source.onmessage = (event) => {
      if (isStale()) return;
      observeCursor(event.lastEventId);
      try {
        const decoded = decoder.decode(event.data);
        if (decoded.kind === 'command') commandResults.publish(decoded.event);
      } catch {
        // Malformed frames are transport noise; authoritative reconciliation
        // recovers the command state instead of guessing from the frame.
      }
    };
    source.onerror = (event) => {
      if (isStale()) return;
      publishStatus('reconnecting');
      failures.publish({ message: 'command stream transport error', cause: event });
      // EventSource would auto-reconnect with an unowned timer; the transport owns
      // the single connection explicitly and reopens after reconnectDelayMs.
      restartConnection();
    };

    publishStatus('connecting');
    state.connectTimer = setTimeout(() => {
      state.connectTimer = undefined;
      if (!isCurrent()) return;
      publishStatus('failed');
      failures.publish({ message: 'command stream connect timeout' });
      emitDirty('closed', 1);
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
    if (statuses.subscriberCount === 1) statuses.publish(state.status);
  });

  return {
    commandResults: commandResults.stream,
    reconnected: reconnections.stream,
    gaps: gaps.stream,
    connectionStatus: statuses.stream,
    transportFailures: failures.stream,
    dirty: dirty.stream,
  };
}
