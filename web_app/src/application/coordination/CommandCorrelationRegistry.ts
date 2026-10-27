import type { CommandResultEvent } from '../contracts/CommandEvents';

export type CorrelationDecision = 'new' | 'duplicate' | 'stale';

/**
 * Per-(fabId, commandId) revision watermarks. It records every accepted
 * revision before workflow delivery so duplicate/out-of-order frames can never
 * advance or regress a workflow state. It deliberately keeps no command data
 * beyond the watermark.
 */
export class CommandCorrelationRegistry {
  private readonly revisions = new Map<string, number>();

  private static key(fabId: string, commandId: string): string {
    return `${fabId}\u0000${commandId}`;
  }

  observe(event: CommandResultEvent): CorrelationDecision {
    const key = CommandCorrelationRegistry.key(event.fabId, event.commandId);
    const last = this.revisions.get(key);
    if (last === undefined || event.revision > last) {
      this.revisions.set(key, event.revision);
      return 'new';
    }
    return event.revision === last ? 'duplicate' : 'stale';
  }

  lastRevision(fabId: string, commandId: string): number | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId));
  }

  clear(): void {
    this.revisions.clear();
  }

  get size(): number {
    return this.revisions.size;
  }
}
