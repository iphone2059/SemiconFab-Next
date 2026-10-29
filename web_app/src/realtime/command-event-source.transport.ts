import { Observable, Subject, share } from 'rxjs';
import type { CommandEventSource, CommandResultEvent, CommandStreamGap } from '@/contracts/command-events.contract';
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
 * Command-result transport backed by the backend SSE stream. The backend emits
 * MessageDecoder envelopes; decode happens once here and consumers see typed
 * events only. EventSource reconnection is delegated to the browser.
 *
 * The journal cursor (`id: {epoch}:{sequence}`) is tracked so the transport can
 * surface `replay-gap` control frames as an explicit `gaps$` signal: the caller
 * must then reconcile authoritative command state because replay is incomplete.
 */
export function createSseCommandEventSource(url: string, options: SseCommandEventSourceOptions = {}): CommandEventSource {
  const reconnected = new Subject<void>();
  const gaps = new Subject<CommandStreamGap>();
  return {
    reconnected$: reconnected.asObservable(),
    gaps$: gaps.asObservable(),
    commandResult$: new Observable<CommandResultEvent>((subscriber) => {
      const factory = options.eventSourceFactory ??
        (typeof EventSource === 'undefined' ? undefined : (target: string) => new EventSource(target) as unknown as EventSourceLike);
      if (!factory) {
        subscriber.error(new Error('EventSource is not available in this environment'));
        return undefined;
      }
      const decoder = new MessageDecoder();
      const source = factory(url);
      let opened = false;
      let cursor: CommandCursor = {};
      const onReplayGap = (event: SseMessageLike) => {
        if (subscriber.closed) return;
        // The gap control frame carries no id line; keep the last valid cursor.
        const observed = parseCommandCursor(event.lastEventId);
        if (observed.epoch !== undefined) cursor.epoch = observed.epoch;
        if (observed.sequence !== undefined) cursor.sequence = observed.sequence;
        gaps.next(parseCommandReplayGap(event.data, cursor));
      };
      source.addEventListener?.('replay-gap', onReplayGap);
      source.onopen = () => {
        if (subscriber.closed) return;
        if (opened) reconnected.next();
        opened = true;
      };
      source.onmessage = (event) => {
        // Merge the cursor: frames without an id line must not erase the epoch.
        const observed = parseCommandCursor(event.lastEventId);
        if (observed.epoch !== undefined) cursor.epoch = observed.epoch;
        if (observed.sequence !== undefined) cursor.sequence = observed.sequence;
        try {
          const decoded = decoder.decode(event.data);
          if (decoded.kind === 'command') subscriber.next(decoded.event);
        } catch {
          // Malformed frames are transport noise; keep the stream alive and let
          // backend reconciliation recover the authoritative state.
        }
      };
      source.onerror = () => {
        // EventSource reconnects automatically; a terminal error surfaces when
        // the runtime is disposed and closes the source.
      };
      return () => {
        source.removeEventListener?.('replay-gap', onReplayGap);
        source.onopen = null; source.onmessage = null; source.onerror = null;
        source.close();
      };
    }).pipe(share()),
  };
}
