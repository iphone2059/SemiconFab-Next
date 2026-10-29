import { Effect, PubSub, Result, Stream } from 'effect';
import type { CommandConnectionStatus, CommandEventSource, CommandResultEvent, CommandStreamGap, CommandTransportFailure } from '@/contracts/command-events.contract';
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

export interface SseCommandEventSourceOptions {
  /** Test seam; production defaults to the browser EventSource. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
}

interface CommandCursor {
  epoch?: string;
  sequence?: number;
}

type CommandStreamMessage =
  | { readonly kind: 'result'; readonly event: CommandResultEvent }
  | { readonly kind: 'reconnected' }
  | { readonly kind: 'gap'; readonly gap: CommandStreamGap }
  | { readonly kind: 'status'; readonly status: CommandConnectionStatus }
  | { readonly kind: 'failure'; readonly failure: CommandTransportFailure };

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

/**
 * Command-result transport backed by one FAB SSE stream. Task 6 replaces the
 * RxJS Observable bridge with Effect PubSub + Streams: all five signals are
 * derived from one typed message bus and one lazily opened EventSource, opened
 * by the first subscriber and closed when the last stream consumer exits.
 *
 * The journal cursor (`id: {epoch}:{sequence}`) is tracked so replay-gap control
 * frames become an explicit Stream signal rather than being silently ignored.
 */
export function createSseCommandEventSource(url: string, options: SseCommandEventSourceOptions = {}): CommandEventSource {
  const bus = Effect.runSync(PubSub.unbounded<CommandStreamMessage>());
  const decoder = new MessageDecoder();
  const state: {
    status: CommandConnectionStatus;
    subscribers: number;
    source: EventSourceLike | null;
    opened: boolean;
    cursor: CommandCursor;
  } = { status: 'connecting', subscribers: 0, source: null, opened: false, cursor: {} };

  const publish = (message: CommandStreamMessage): void => { PubSub.publishUnsafe(bus, message); };
  const publishStatus = (status: CommandConnectionStatus): void => {
    state.status = status;
    publish({ kind: 'status', status });
  };

  const open = (): void => {
    const factory = options.eventSourceFactory ??
      (typeof EventSource === 'undefined' ? undefined : (target: string) => new EventSource(target) as unknown as EventSourceLike);
    if (!factory) {
      publishStatus('failed');
      publish({ kind: 'failure', failure: { message: 'EventSource is not available in this environment' } });
      return;
    }
    const source = factory(url);
    state.source = source;
    const onReplayGap = (event: SseMessageLike): void => {
      const observed = parseCommandCursor(event.lastEventId);
      if (observed.epoch !== undefined) state.cursor.epoch = observed.epoch;
      if (observed.sequence !== undefined) state.cursor.sequence = observed.sequence;
      publish({ kind: 'gap', gap: parseCommandReplayGap(event.data, state.cursor) });
    };
    source.addEventListener?.('replay-gap', onReplayGap);
    source.onopen = () => {
      if (state.opened) publish({ kind: 'reconnected' });
      state.opened = true;
      publishStatus('open');
    };
    source.onmessage = (event) => {
      const observed = parseCommandCursor(event.lastEventId);
      if (observed.epoch !== undefined) state.cursor.epoch = observed.epoch;
      if (observed.sequence !== undefined) state.cursor.sequence = observed.sequence;
      try {
        const decoded = decoder.decode(event.data);
        if (decoded.kind === 'command') publish({ kind: 'result', event: decoded.event });
      } catch {
        // Malformed frames are transport noise; keep the stream alive and let
        // backend reconciliation recover the authoritative state.
      }
    };
    source.onerror = (event) => {
      // EventSource reconnects automatically; surface the interruption so the
      // runtime can reconcile authoritative state instead of silently ignoring it.
      publishStatus('reconnecting');
      publish({ kind: 'failure', failure: { message: 'command stream transport error', cause: event } });
    };
  };

  const close = (): void => {
    if (!state.source) return;
    state.source.onopen = null;
    state.source.onmessage = null;
    state.source.onerror = null;
    state.source.close();
    state.source = null;
    // A later consumer starts a fresh connection generation; its first open is
    // not a reconnection of the previous lifetime.
    state.opened = false;
  };

  const acquire = (): void => {
    state.subscribers += 1;
    if (state.subscribers === 1) open();
  };
  const release = (): void => {
    state.subscribers = Math.max(0, state.subscribers - 1);
    if (state.subscribers === 0) close();
  };

  const messages = Stream.fromPubSub(bus);
  /**
   * The command-result stream owns the connection lifetime: FabRuntime only starts
   * it when the first command is tracked, preserving lazy FAB SSE. Status/gap/
   * failure streams observe an already-open connection and never open one.
   */
  const lifecycle = <A>(stream: Stream.Stream<A>): Stream.Stream<A> => stream.pipe(
    Stream.onStart(Effect.sync(acquire)),
    Stream.ensuring(Effect.sync(release)),
  );
  const select = <A>(read: (message: CommandStreamMessage) => A | undefined): Stream.Stream<A> =>
    messages.pipe(Stream.filterMap((message) => {
      const value = read(message);
      return value === undefined ? Result.fail(undefined) : Result.succeed(value);
    }));

  return {
    commandResults: lifecycle(select((message) => message.kind === 'result' ? message.event : undefined)),
    reconnected: messages.pipe(Stream.filterMap((message) => message.kind === 'reconnected' ? Result.succeed(undefined) : Result.fail(undefined))),
    gaps: select((message) => message.kind === 'gap' ? message.gap : undefined),
    connectionStatus: Stream.concat(
      Stream.sync(() => state.status),
      select((message) => message.kind === 'status' ? message.status : undefined),
    ),
    transportFailures: select((message) => message.kind === 'failure' ? message.failure : undefined),
  };
}
