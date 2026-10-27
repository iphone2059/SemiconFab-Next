import { Observable, Subject, share } from 'rxjs';
import type { CommandEventSource, CommandResultEvent } from '../../application/contracts/CommandEvents';
import { MessageDecoder } from '../protocol/MessageDecoder';

interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface SseCommandEventSourceOptions {
  /** Test seam; production defaults to the browser EventSource. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
}

/**
 * Command-result transport backed by the backend SSE stream. The backend emits
 * MessageDecoder envelopes; decode happens once here and consumers see typed
 * events only. EventSource reconnection is delegated to the browser.
 */
export function createSseCommandEventSource(url: string, options: SseCommandEventSourceOptions = {}): CommandEventSource {
  const reconnected = new Subject<void>();
  return {
    reconnected$: reconnected.asObservable(),
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
      source.onopen = () => {
        if (subscriber.closed) return;
        if (opened) reconnected.next();
        opened = true;
      };
      source.onmessage = (event) => {
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
        source.onopen = null; source.onmessage = null; source.onerror = null;
        source.close();
      };
    }).pipe(share()),
  };
}
