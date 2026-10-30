import { Stream } from 'effect';
import type { CommandEventSource } from '@/contracts/command-events.contract';

/**
 * Display-only command source for environments that cannot host an EventSource
 * (e.g. jsdom/Storybook) or before a FAB runtime is assembled (R4-06).
 *
 * It is explicitly marked `availability: 'unavailable'`: it delivers no journal
 * cursor, has no ordered ACK ledger and must never be treated as a recovery
 * authority or reported Healthy (R3-07 / ADR-010 §6.5). acknowledge/cover are
 * deliberate no-ops because nothing was delivered or authoritatively recovered;
 * the bounded protocol diagnostics stay empty. There is no compat shim here: a
 * runtime that needs recovery must receive a real CommandEventSource.
 *
 * An HTTP gateway can still recover records while this source is unavailable;
 * the runtime remains Degraded because no live stream can be covered.
 */
export function createPendingCommandEventSource(): CommandEventSource {
  return {
    commandResults: Stream.empty,
    reconnected: Stream.empty,
    gaps: Stream.empty,
    connectionStatus: Stream.empty,
    transportFailures: Stream.empty,
    dirty: Stream.empty,
    acknowledge: () => undefined,
    cover: (cursor, authority = 'journal') => ({ status: 'insufficient', cursor, authority, latchReleased: false, reason: 'transport unavailable', recovery: 'list' }),
    lossGeneration: 0,
    availability: 'unavailable',
    protocolDiagnostics: Object.freeze([]),
    cursors: {},
  };
}
