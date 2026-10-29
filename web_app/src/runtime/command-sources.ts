import { Stream } from 'effect';
import type { CommandEventSource } from '@/contracts/command-events.contract';

/**
 * Empty command stream used when EventSource is unavailable (jsdom/tests) or
 * before the FAB runtime is assembled. It is a real Effect Stream so consumers
 * never branch on an Observable/Stream mismatch, and it still implements the
 * ADR-010 acknowledge/cursor capability as an explicit no-op (nothing was
 * delivered, so there is nothing to acknowledge).
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
    cursors: {},
  };
}
