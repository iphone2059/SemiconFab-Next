import { EMPTY } from 'rxjs';
import type { CommandEventSource } from '../application/contracts/CommandEvents';

/**
 * Product command source placeholder. The backend realtime transport is still a
 * placeholder, so the assembled FAB runtimes subscribe to an empty stream; when
 * the SSE/WebSocket command endpoint lands, replace this factory with the typed
 * transport adapter (the CommandEventSource contract is the seam).
 */
export function createPendingCommandEventSource(): CommandEventSource {
  return { commandResult$: EMPTY };
}
