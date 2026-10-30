import { Stream } from 'effect';
import type { CommandEventSource } from '@/contracts/command-events.contract';

/**
 * Placeholder command source used when the environment cannot host an EventSource
 * (e.g. jsdom) or before a FAB runtime is assembled.
 *
 * It is explicitly marked `availability: 'unavailable'`: it delivers no journal
 * cursor, has no ordered ACK ledger and must never be treated as a recovery
 * authority or reported Healthy (R3-07 / ADR-010 §6.5). acknowledge/cover are
 * deliberate no-ops because nothing was delivered or authoritatively recovered;
 * the bounded protocol diagnostics stay empty. There is no compat shim here: a
 * runtime that needs recovery must receive a real CommandEventSource.
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
    cover: () => undefined,
    availability: 'unavailable',
    protocolDiagnostics: Object.freeze([]),
    cursors: {},
  };
}
