import type { CommandOutcome, CommandResultEvent } from '../contracts/CommandEvents';

export type CorrelationDecision = 'new' | 'duplicate' | 'stale';

export interface CorrelationRetentionOptions {
  /** Max retained terminal correlation entries; oldest terminal entries go first. */
  readonly maxTerminalEntries?: number;
  /** Terminal entries are forgotten after this long, so the registry cannot grow forever. */
  readonly terminalTtlMs?: number;
  /** Absolute safety cap; active (non-terminal) commands are never evicted for it. */
  readonly maxEntries?: number;
  /** Test seam; production uses Date.now. */
  readonly now?: () => number;
}

const TERMINAL_OUTCOMES: ReadonlySet<CommandOutcome> = new Set(['succeeded', 'failed', 'cancelled']);

interface CorrelationEntry {
  readonly revision: number;
  readonly terminal: boolean;
  updatedAt: number;
}

/**
 * Per-(fabId, commandId) revision watermarks. It records every accepted
 * revision before workflow delivery so duplicate/out-of-order frames can never
 * advance or regress a workflow state.
 *
 * Retention is bounded: active commands are always retained, while terminal
 * entries expire by TTL / terminal count (the runtime sweeps them). The
 * registry keeps no command payload beyond the watermark.
 */
export class CommandCorrelationRegistry {
  private readonly revisions = new Map<string, CorrelationEntry>();
  private readonly maxTerminalEntries: number;
  private readonly terminalTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CorrelationRetentionOptions = {}) {
    this.maxTerminalEntries = Math.max(1, options.maxTerminalEntries ?? 256);
    this.terminalTtlMs = Math.max(0, options.terminalTtlMs ?? 300_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 4_096);
    this.now = options.now ?? Date.now;
  }

  private static key(fabId: string, commandId: string): string {
    return `${fabId}\u0000${commandId}`;
  }

  observe(event: CommandResultEvent): CorrelationDecision {
    const key = CommandCorrelationRegistry.key(event.fabId, event.commandId);
    const last = this.revisions.get(key);
    if (last === undefined || event.revision > last.revision) {
      this.revisions.set(key, {
        revision: event.revision,
        terminal: TERMINAL_OUTCOMES.has(event.outcome),
        updatedAt: this.now(),
      });
      this.enforceBounds();
      return 'new';
    }
    return event.revision === last.revision ? 'duplicate' : 'stale';
  }

  lastRevision(fabId: string, commandId: string): number | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.revision;
  }

  isTerminal(fabId: string, commandId: string): boolean | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.terminal;
  }

  /**
   * Evict expired terminal watermarks and enforce the terminal/absolute caps.
   * Active commands are retained regardless of age: a running command needs its
   * revision watermark for duplicate/ordering decisions.
   */
  sweep(): number {
    const now = this.now();
    let evicted = 0;
    if (this.terminalTtlMs > 0) {
      for (const [key, entry] of this.revisions) {
        if (entry.terminal && now - entry.updatedAt >= this.terminalTtlMs) {
          this.revisions.delete(key);
          evicted += 1;
        }
      }
    }
    evicted += this.enforceBounds();
    return evicted;
  }

  clear(): void {
    this.revisions.clear();
  }

  get size(): number {
    return this.revisions.size;
  }

  get terminalCount(): number {
    let count = 0;
    for (const entry of this.revisions.values()) if (entry.terminal) count += 1;
    return count;
  }

  private enforceBounds(): number {
    let evicted = 0;
    let terminalKeys = [...this.revisions].filter(([, entry]) => entry.terminal).map(([key]) => key);
    while (terminalKeys.length > this.maxTerminalEntries) {
      this.revisions.delete(terminalKeys[0]);
      terminalKeys = terminalKeys.slice(1);
      evicted += 1;
    }
    while (this.revisions.size > this.maxEntries && terminalKeys.length > 0) {
      this.revisions.delete(terminalKeys[0]);
      terminalKeys = terminalKeys.slice(1);
      evicted += 1;
    }
    return evicted;
  }
}
