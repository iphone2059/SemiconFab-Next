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
 * R4-06 composition contract: this source is only ever paired with an explicitly
 * display-only runtime — FabRuntimeFactory must receive `gateway: undefined`.
 * The composition root must never create an authoritative HTTP CommandGateway
 * around this source: recovery authority over a stream that can never deliver a
 * command result is a false health claim. A production composition root therefore
 * fails fast instead of assembling this source (see runtime-bootstrap.tsx).
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
