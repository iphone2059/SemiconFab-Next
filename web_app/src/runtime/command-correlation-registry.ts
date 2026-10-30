import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
import {
  resolveClockOption,
  resolveIntegerOption,
  resolveTimeoutOption,
} from '@/contracts/command-config';

/**
 * Result of correlating one observed command-result revision (Round 5.1 / P1-02).
 *
 * - `new`: this observation is the first for the command, or it carries a newer
 *   revision than the recorded watermark; the record now tracks it.
 * - `duplicate`: same (highest) revision and the same outcome as the recorded
 *   observation; no record mutation.
 * - `stale`: older revision than the recorded watermark; no record mutation.
 * - `conflict`: same (highest) revision but a *different* outcome than the one
 *   recorded. The revision invariant "one revision has exactly one outcome" was
 *   violated on the wire. The ordinary realtime path never mutates the record:
 *   only an authoritative source may resolve/correct the recorded outcome
 *   (`observeAuthoritative`).
 */
export type CorrelationDecision = 'new' | 'duplicate' | 'stale' | 'conflict';

export interface CorrelationRetentionOptions {
  /** Max retained terminal correlation entries; the oldest *completed* terminals go first. */
  readonly maxTerminalEntries?: number;
  /** Terminal entries are forgotten after this long, so the registry cannot grow forever. */
  readonly terminalTtlMs?: number;
  /**
   * Hard absolute cap on retained watermarks (R4-08 frontend). Terminal entries are
   * evicted first; when only active entries remain the oldest active entry is evicted
   * too: bounded memory beats an unbounded registry. Losing an active watermark can
   * only let a later duplicate/out-of-order frame be observed again; the actor
   * projection still rejects a revision it has already passed.
   */
  readonly maxEntries?: number;
  /** Test seam; production uses Date.now. */
  readonly now?: () => number;
}

const TERMINAL_OUTCOMES: ReadonlySet<CommandOutcome> = new Set(['succeeded', 'failed', 'cancelled']);

interface CorrelationEntry {
  /** Highest revision observed on the wire; dedupe/ordering watermark. */
  readonly revision: number;
  /**
   * Outcome recorded for the current highest observed revision (Round 5.1 /
   * P1-02). A same-revision realtime observation with a different outcome is a
   * conflict and must never mutate this value; only an authoritative observation
   * may correct it.
   */
  readonly outcome: CommandOutcome;
  /**
   * Highest revision the actor projection provably applied (R4-03). This advances
   * only forward and only through markApplied(); it is deliberately a different
   * watermark from the observed revision so an authoritative re-application can
   * bypass the SSE duplicate gate without lying about application.
   */
  appliedRevision?: number;
  /** Derived from `outcome`; maintained so terminal retention stays O(1). */
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
 * advance or regress a workflow state. Observed and applied watermarks are kept
 * separate (R4-03): the observed watermark deduplicates the realtime stream,
 * while the applied watermark is only advanced after the actor projection proved
 * it advanced.
 *
 * Round 5.1 / P1-02: the registry also owns the *outcome* invariant for the
 * current highest observed revision. A realtime observation with the same
 * revision but a different outcome is a protocol conflict: it is reported but
 * never mutates the record and never moves the applied watermark. Only the
 * authoritative entry point may resolve/correct the recorded outcome, and it may
 * never roll the revision or outcome back to an older revision.
 *
 * Retention is bounded: terminal entries expire by TTL / terminal count (the
 * runtime sweeps them), and maxEntries is a hard cap (R4-08). The registry keeps
 * no command payload beyond the watermarks.
 *
 * The main index is O(1) per observed event. Terminal entries additionally live
 * in a completion-ordered queue so the terminal caps only ever evict the *oldest
 * completed* command (Map insertion order would evict a long-running command that
 * finishes last). Only when the hard cap is exceeded and no terminal entry is
 * left is the oldest active entry evicted.
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
    this.maxTerminalEntries = resolveIntegerOption(
      'correlation.maxTerminalEntries',
      options.maxTerminalEntries,
      256,
      { min: 1 },
    );
    this.terminalTtlMs = resolveTimeoutOption('correlation.terminalTtlMs', options.terminalTtlMs, 300_000, {
      min: 0,
    });
    this.maxEntries = resolveIntegerOption('correlation.maxEntries', options.maxEntries, 4_096, { min: 1 });
    this.now = resolveClockOption('correlation.now', options.now, Date.now);
  }

  private static key(fabId: string, commandId: string): string {
    return `${fabId}\u0000${commandId}`;
  }

  /**
   * Ordinary (realtime) observation. This is the only entry point allowed to
   * report a same-revision outcome disagreement as `conflict`; it never mutates
   * an existing record for a duplicate/stale/conflict decision.
   */
  observe(event: CommandResultEvent): CorrelationDecision {
    const key = CommandCorrelationRegistry.key(event.fabId, event.commandId);
    const last = this.revisions.get(key);
    if (last === undefined) {
      this.recordNew(key, event, undefined);
      return 'new';
    }
    if (event.revision > last.revision) {
      this.recordNew(key, event, last);
      return 'new';
    }
    if (event.revision < last.revision) return 'stale';
    // Same revision: only an identical outcome may be treated as a duplicate.
    return event.outcome === last.outcome ? 'duplicate' : 'conflict';
  }

  /**
   * Authoritative observation (Round 5.1 / P1-02). The authoritative List/Journal
   * snapshot is allowed to resolve a same-revision outcome conflict and correct
   * the recorded outcome; it can never roll the watermark back:
   *
   * - no record / newer revision -> record it and return `new`;
   * - same revision, same outcome -> `duplicate`;
   * - same revision, different outcome -> correct the recorded outcome (and the
   *   terminal bookkeeping) and return `new` (the correction must be re-delivered);
   * - older revision -> `stale` with no revision/outcome rollback.
   */
  observeAuthoritative(event: CommandResultEvent): CorrelationDecision {
    const key = CommandCorrelationRegistry.key(event.fabId, event.commandId);
    const last = this.revisions.get(key);
    if (last === undefined) {
      this.recordNew(key, event, undefined);
      return 'new';
    }
    if (event.revision > last.revision) {
      this.recordNew(key, event, last);
      return 'new';
    }
    if (event.revision < last.revision) return 'stale';
    if (event.outcome === last.outcome) return 'duplicate';
    this.correctOutcome(key, last, event.outcome);
    return 'new';
  }

  /**
   * Record a brand-new observed revision (first observation or newer revision).
   * Preserves the applied watermark (coverage of already-applied revisions
   * survives a newer observation) and keeps terminal retention bookkeeping
   * coherent when a terminal entry is superseded by a newer revision.
   */
  private recordNew(
    key: string,
    event: CommandResultEvent,
    previous: CorrelationEntry | undefined,
  ): void {
    const terminal = TERMINAL_OUTCOMES.has(event.outcome);
    if (previous?.terminal) this.terminalEntries -= 1;
    const entry: CorrelationEntry = {
      revision: event.revision,
      outcome: event.outcome,
      // Coverage of already-applied revisions survives a newer observation.
      ...(previous?.appliedRevision !== undefined ? { appliedRevision: previous.appliedRevision } : {}),
      terminal,
      updatedAt: this.now(),
      terminalSeq: terminal ? ++this.terminalSeq : 0,
    };
    this.revisions.set(key, entry);
    if (terminal) {
      this.terminalOrder.push({ key, seq: entry.terminalSeq });
      this.terminalEntries += 1;
    }
    // Per-event bound enforcement: terminal additions can grow the terminal
    // set, active additions can only relevantly hit the hard absolute cap.
    this.enforceBounds();
  }

  /**
   * Authoritative same-revision outcome correction. The revision never changes,
   * so the terminal-completion queue entry must be kept, added or dropped in a
   * way that preserves the terminal-head invariant:
   *
   * - active -> terminal: assign a new completion seq and enqueue it;
   * - terminal -> active: un-count it; its old queue entry is pruned lazily;
   * - terminal -> terminal: keep the existing seq (the queue entry stays valid),
   *   only the recorded outcome changes.
   */
  private correctOutcome(key: string, previous: CorrelationEntry, outcome: CommandOutcome): void {
    const terminal = TERMINAL_OUTCOMES.has(outcome);
    const terminalSeq = terminal
      ? previous.terminal ? previous.terminalSeq : ++this.terminalSeq
      : 0;
    const entry: CorrelationEntry = {
      revision: previous.revision,
      outcome,
      ...(previous.appliedRevision !== undefined ? { appliedRevision: previous.appliedRevision } : {}),
      terminal,
      updatedAt: this.now(),
      terminalSeq,
    };
    if (previous.terminal && !terminal) {
      this.terminalEntries -= 1;
    } else if (!previous.terminal && terminal) {
      this.terminalEntries += 1;
    }
    this.revisions.set(key, entry);
    if (!previous.terminal && terminal) {
      this.terminalOrder.push({ key, seq: terminalSeq });
      this.enforceBounds();
    }
  }

  /**
   * Record that the actor projection provably applied this revision (R4-03,
   * ADR-010 §6.2). Round 5.1 / P1-02: the applied watermark may only advance
   * when the event's outcome matches the recorded outcome for the current
   * highest revision — an ordinary conflicting event proves nothing and must be
   * resolved by authority first. Forward-only: a call can never regress the
   * applied watermark. The entry is normally created by observe(); a defensive
   * observation is made if the caller skipped it.
   */
  markApplied(event: CommandResultEvent): void {
    const key = CommandCorrelationRegistry.key(event.fabId, event.commandId);
    let entry = this.revisions.get(key);
    if (entry === undefined) {
      this.observe(event);
      entry = this.revisions.get(key);
      if (entry === undefined) return;
    }
    if (entry.outcome !== event.outcome) return;
    if (entry.appliedRevision === undefined || event.revision > entry.appliedRevision) {
      entry.appliedRevision = event.revision;
    }
  }

  lastObservedRevision(fabId: string, commandId: string): number | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.revision;
  }

  /** Outcome recorded for the current highest observed revision (Round 5.1 / P1-02). */
  lastObservedOutcome(fabId: string, commandId: string): CommandOutcome | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.outcome;
  }

  hasUnappliedObservation(fabId: string, commandId: string): boolean {
    const entry = this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId));
    return entry !== undefined && (entry.appliedRevision === undefined || entry.revision > entry.appliedRevision);
  }

  /** Highest revision the actor projection provably applied, if any (R4-03). */
  lastAppliedRevision(fabId: string, commandId: string): number | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.appliedRevision;
  }

  /** Documented alias of lastAppliedRevision for the applied-watermark API. */
  appliedRevision(fabId: string, commandId: string): number | undefined {
    return this.lastAppliedRevision(fabId, commandId);
  }

  isTerminal(fabId: string, commandId: string): boolean | undefined {
    return this.revisions.get(CommandCorrelationRegistry.key(fabId, commandId))?.terminal;
  }

  /**
   * Evict expired terminal watermarks and enforce the terminal/absolute caps.
   * Active commands are retained across sweeps (their watermark is still needed
   * for duplicate/ordering decisions), but maxEntries is a hard cap (R4-08): if
   * only active commands remain above it, the oldest active entry is evicted.
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

  /** Evict from the completion-order head; returns null when no terminal entry remains. */
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

  /** Oldest retained active key (Map insertion order is first-observation order). */
  private firstActiveKey(): string | undefined {
    for (const [key, entry] of this.revisions) {
      if (!entry.terminal) return key;
    }
    return undefined;
  }

  private enforceBounds(): number {
    let evicted = 0;
    // Terminal retention is bounded first: the oldest completed terminal goes.
    while (this.terminalEntries > this.maxTerminalEntries) {
      const oldest = this.nextTerminal();
      if (oldest === null) break;
      this.revisions.delete(oldest.key);
      this.terminalEntries -= 1;
      evicted += 1;
    }
    // maxEntries is a hard cap (R4-08): terminal entries are sacrificed before
    // active ones, and with only active entries the oldest active entry goes.
    while (this.revisions.size > this.maxEntries) {
      const oldestTerminal = this.nextTerminal();
      if (oldestTerminal !== null) {
        this.revisions.delete(oldestTerminal.key);
        this.terminalEntries -= 1;
        evicted += 1;
        continue;
      }
      const oldestActive = this.firstActiveKey();
      if (oldestActive === undefined) break;
      this.revisions.delete(oldestActive);
      evicted += 1;
    }
    return evicted;
  }
}
