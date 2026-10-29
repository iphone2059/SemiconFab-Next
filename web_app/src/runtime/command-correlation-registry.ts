import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';

export type CorrelationDecision = 'new' | 'duplicate' | 'stale';

export interface CorrelationRetentionOptions {
  /** Max retained terminal correlation entries; the oldest *completed* terminals go first. */
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
  /** Monotonic completion sequence for terminal entries; 0 for active entries. */
  readonly terminalSeq: number;
}

/** Order entry in the terminal-completion queue; pruned lazily if its command moves on. */
interface TerminalOrderEntry {
  readonly key: string;
  readonly seq: number;
}

/**
 * Per-(fabId, commandId) revision watermarks. It records every accepted
 * revision before workflow delivery so duplicate/out-of-order frames can never
 * advance or regress a workflow state.
 *
 * Retention is bounded: active commands are always retained, while terminal
 * entries expire by TTL / terminal count (the runtime sweeps them). The registry
 * keeps no command payload beyond the watermark.
 *
 * The main index is O(1) per observed event. Terminal entries additionally live
 * in a completion-ordered queue so the cap only ever evicts the *oldest
 * completed* command (Map insertion order would evict a long-running command
 * that finishes last), and active commands are never eviction candidates.
 */
export class CommandCorrelationRegistry {
  private readonly revisions = new Map<string, CorrelationEntry>();
  /** Terminal keys in completion order; `terminalHead` advances as entries are evicted. */
  private readonly terminalOrder: TerminalOrderEntry[] = [];
  private terminalHead = 0;
  private terminalSeq = 0;
  private terminalEntries = 0;
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
      const terminal = TERMINAL_OUTCOMES.has(event.outcome);
      // A superseded entry (rare: terminal command receiving a newer revision)
      // leaves a stale order entry that the eviction/reconciliation paths skip.
      if (last?.terminal) this.terminalEntries -= 1;
      const entry: CorrelationEntry = {
        revision: event.revision,
        terminal,
        updatedAt: this.now(),
        terminalSeq: terminal ? ++this.terminalSeq : 0,
      };
      this.revisions.set(key, entry);
      if (terminal) {
        this.terminalOrder.push({ key, seq: entry.terminalSeq });
        this.terminalEntries += 1;
        // Only terminal additions can grow the bounded terminal set, so this is
        // the only per-event place that may need to evict (never an active command).
        this.enforceBounds();
      }
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
   *
   * This is the periodic O(N) sweep; the per-event path stays O(1).
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
    this.rebuildTerminalOrder();
    evicted += this.enforceBounds();
    return evicted;
  }

  clear(): void {
    this.revisions.clear();
    this.terminalOrder.length = 0;
    this.terminalHead = 0;
    this.terminalSeq = 0;
    this.terminalEntries = 0;
  }

  get size(): number {
    return this.revisions.size;
  }

  get terminalCount(): number {
    return this.terminalEntries;
  }

  /** Drop stale order entries and restore the completion-order invariant after the TTL sweep. */
  private rebuildTerminalOrder(): void {
    const retained: TerminalOrderEntry[] = [];
    for (let index = this.terminalHead; index < this.terminalOrder.length; index += 1) {
      const entry = this.terminalOrder[index];
      const current = this.revisions.get(entry.key);
      if (current !== undefined && current.terminal && current.terminalSeq === entry.seq) retained.push(entry);
    }
    this.terminalOrder.length = 0;
    for (const entry of retained) this.terminalOrder.push(entry);
    this.terminalHead = 0;
    // Recompute defensively: the counter tracks terminal additions/replacements,
    // while this method is the one place that can observe every retained entry.
    let terminalEntries = 0;
    for (const entry of this.revisions.values()) if (entry.terminal) terminalEntries += 1;
    this.terminalEntries = terminalEntries;
  }

  /** Evict from the completion-order head; returns null when only active commands remain. */
  private nextTerminal(): TerminalOrderEntry | null {
    while (this.terminalHead < this.terminalOrder.length) {
      const entry = this.terminalOrder[this.terminalHead];
      this.terminalHead += 1;
      const current = this.revisions.get(entry.key);
      if (current !== undefined && current.terminal && current.terminalSeq === entry.seq) return entry;
    }
    if (this.terminalHead > 0) {
      this.terminalOrder.length = 0;
      this.terminalHead = 0;
    }
    return null;
  }

  private enforceBounds(): number {
    let evicted = 0;
    while (this.terminalEntries > this.maxTerminalEntries || this.revisions.size > this.maxEntries) {
      const oldest = this.nextTerminal();
      // Only terminal commands are eviction candidates: an active command must
      // keep its watermark no matter how many active commands exceed maxEntries.
      if (oldest === null) break;
      this.revisions.delete(oldest.key);
      this.terminalEntries -= 1;
      evicted += 1;
    }
    return evicted;
  }
}
