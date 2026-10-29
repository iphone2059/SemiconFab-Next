import { EMPTY } from 'rxjs';
import type { CommandEventSource } from '@/contracts/command-events.contract';

/**
 * Fallback command source for environments without EventSource (tests/SSR) and
 * the replaceable seam for future transports. Product RuntimeBootstrap prefers
 * the backend SSE command stream; WebSocket can replace it behind the same
 * CommandEventSource contract.
 */
export function createPendingCommandEventSource(): CommandEventSource {
  return { commandResult$: EMPTY };
}
