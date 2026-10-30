import type { Effect } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import { resolveIntegerOption } from '@/contracts/command-config';

export interface CommandRecoveryOptions {
  /** Max held revisions per (fabId, commandId). */
  readonly maxPerCommand?: number;
  /** Max held revisions across all commands. */
  readonly maxTotal?: number;
  /** Max retained unresolved same-revision outcome conflicts (Round 5.1 / P1-02). */
  readonly maxConflicts?: number;
  /**
   * Called for every capacity eviction. FabRuntime turns this observable
   * diagnostic into a coalesced authoritative reconciliation because a dropped
   * revision may mean the local stream state is no longer complete.
   */
  readonly onEvict?: (eviction: CommandRecoveryEviction) => void;
}

export interface CommandRecoveryEviction {
  readonly event: CommandResultEvent;
  readonly reason: 'per-command' | 'global';
  readonly terminal: boolean;
  readonly droppedTotal: number;
}

/**
 * Result of offering an event to the bounded recovery queue (Round 5.1 / P1-02).
 * `conflict` means the queue already holds the same command+revision with a
 * different outcome: the revision invariant was violated on the wire and only an
 * authoritative observation may resolve it.
 */
export type CommandRecoveryHoldResult = 'inserted' | 'duplicate' | 'conflict';

/**
 * Bounded record of one unresolved same-revision outcome conflict. This is a
 * protocol diagnostic, never an event to apply: it is excluded from
 * snapshot()/drain()/pendingFor() and is never delivered by flushRecovery(). It
 * only leaves the queue when an authoritative observation covers that revision
 * (`resolveAuthoritative`).
 */
export interface CommandRecoveryConflict {
  readonly fabId: string;
  readonly commandId: string;
  readonly revision: number;
  /** The conflicting (later) event whose outcome disagreed with the record. */
  readonly event: CommandResultEvent;
  /**
   * The event already held for that same revision when the conflict arrived, if
   * it was still queued. Undefined when the earlier event had already been
   * applied/released (only the correlation watermark remembers it).
   */
  readonly held?: CommandResultEvent;
  /** Global arrival sequence of the conflict within this queue (diagnostics/order). */
  readonly seq: number;
}

const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled']);
const isTerminal = (event: CommandResultEvent): boolean => TERMINAL_OUTCOMES.has(event.outcome);

const keyOf = (event: Pick<CommandResultEvent, 'fabId' | 'commandId'>): string =>
  `${event.fabId}\u0000${event.commandId}`;

interface HeldEvent {
  readonly event: CommandResultEvent;
  /** Monotonic global arrival sequence: eviction and drain follow this, not command grouping. */
  readonly seq: number;
}

/**
 * Bounded pending queue for command results that arrive before their workflow
 * exists (confirmation before the HTTP response, page re-mount, actor not created
 * yet). Durable recovery still belongs to the backend; this queue is an in-memory
 * bridge so important terminal results are not silently dropped.
 *
 * Capacity policy (Task 4 stage B): eviction removes a non-terminal event before a
 * terminal one, so a terminal result is the last thing to be dropped. Every eviction
 * is reported through onEvict and retained in bounded diagnostics for tests/UI.
 *
 * R4-03: a retry pass (snapshot/release) reads the queue without draining it, so a
 * failed/rejected re-application stays held instead of being lost on the floor.
 *
 * Round 5.1 / P1-02: the queue also owns the bounded set of unresolved same-revision
 * outcome *conflicts* reported by the correlation layer (including conflicts whose
 * earlier event was already applied). A conflict is never delivered or applied; it
 * participates in `size`/`pendingCount` so Recovery can never become Healthy while
 * an unresolved event conflict exists, and it is cleared only by an authoritative
 * observation covering the revision.
 */
export class CommandEventRecovery {
  private readonly pending = new Map<string, HeldEvent[]>();
  /** Every held event in true global arrival order (the authoritative FIFO). */
  private readonly arrivals: HeldEvent[] = [];
  /** Bounded unresolved same-revision outcome conflicts; never part of the FIFO. */
  private readonly conflictRecords: CommandRecoveryConflict[] = [];
  private nextSeq = 1;
  private total = 0;
  private readonly maxPerCommand: number;
  private readonly maxTotal: number;
  private readonly maxConflicts: number;
  private readonly onEvict?: (eviction: CommandRecoveryEviction) => void;
  private dropped = 0;
  private readonly evictions: CommandRecoveryEviction[] = [];
  private static readonly MAX_DIAGNOSTICS = 16;

  constructor(options: CommandRecoveryOptions = {}) {
    this.maxPerCommand = resolveIntegerOption('recovery.maxPerCommand', options.maxPerCommand, 32, { min: 1 });
    this.maxTotal = resolveIntegerOption('recovery.maxTotal', options.maxTotal, 256, { min: 1 });
    this.maxConflicts = resolveIntegerOption('recovery.maxConflicts', options.maxConflicts, 64, { min: 1 });
    this.onEvict = options.onEvict;
  }

  /**
   * Hold one realtime/queued event. A duplicate revision with the same outcome is
   * a no-op; a duplicate revision with a *different* outcome is a conflict: it is
   * reported but neither inserted nor allowed to overwrite the first held event.
   */
  hold(event: CommandResultEvent): CommandRecoveryHoldResult {
    const key = keyOf(event);
    let queue = this.pending.get(key);
    if (!queue) {
      queue = [];
      this.pending.set(key, queue);
    }
    // Same revision is never re-queued: identical outcome is a duplicate, a
    // different outcome is an unresolved conflict (only authority can resolve it).
    const existing = queue.find((held) => held.event.revision === event.revision);
    if (existing !== undefined) {
      return existing.event.outcome === event.outcome ? 'duplicate' : 'conflict';
    }
    const held: HeldEvent = { event, seq: this.nextSeq++ };
    queue.push(held);
    this.arrivals.push(held);
    this.total += 1;
    while (queue.length > this.maxPerCommand) this.evictOne(queue, key, 'per-command');
    while (this.total > this.maxTotal) this.evictGlobal();
    return 'inserted';
  }

  /**
   * Record an unresolved same-revision outcome conflict reported by correlation.
   * This is deliberately NOT a held event: it can never be applied, so it is
   * excluded from snapshot/drain/pendingFor and from flushRecovery(). The record
   * is deduplicated per (command, revision, outcome) so a repeated conflicting
   * frame cannot grow the queue, and the set is bounded by `maxConflicts` (the
   * oldest unresolved conflict is the one that is dropped).
   */
  holdConflict(event: CommandResultEvent): CommandRecoveryConflict {
    const existing = this.conflictRecords.find(
      (conflict) =>
        conflict.fabId === event.fabId &&
        conflict.commandId === event.commandId &&
        conflict.revision === event.revision &&
        conflict.event.outcome === event.outcome,
    );
    if (existing !== undefined) return existing;
    const queue = this.pending.get(keyOf(event));
    const held = queue?.find((entry) => entry.event.revision === event.revision)?.event;
    const conflict: CommandRecoveryConflict = {
      fabId: event.fabId,
      commandId: event.commandId,
      revision: event.revision,
      event,
      ...(held !== undefined ? { held } : {}),
      seq: this.nextSeq++,
    };
    this.conflictRecords.push(conflict);
    while (this.conflictRecords.length > this.maxConflicts) {
      this.conflictRecords.shift();
      // A dropped conflict record is lost resolution bookkeeping: keep the loss
      // accounting monotonic and observable like any other dropped recovery entry.
      this.dropped += 1;
    }
    return conflict;
  }

  pendingFor(fabId: string, commandId: string): readonly CommandResultEvent[] {
    const queue = this.pending.get(`${fabId}\u0000${commandId}`);
    return queue ? queue.map((held) => held.event) : [];
  }

  /** Snapshot every held event in true global arrival order without removing it (retry pass). */
  snapshot(): readonly CommandResultEvent[] {
    return this.arrivals.map((held) => held.event);
  }

  /**
   * Remove exactly one held event after it was applied/covered. Identity-based:
   * a newer event that replaced the same revision during the pass is never lost,
   * and an event that is no longer held is a harmless no-op.
   */
  release(event: CommandResultEvent): boolean {
    const key = keyOf(event);
    const queue = this.pending.get(key);
    if (!queue) return false;
    const index = queue.findIndex((held) => held.event === event);
    if (index < 0) return false;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
    this.removeArrival(removed.seq);
    this.total -= 1;
    return true;
  }

  /** Drain all pending events in true global arrival order for a retry pass. */
  drain(): readonly CommandResultEvent[] {
    const events = this.arrivals.map((held) => held.event);
    this.pending.clear();
    this.arrivals.length = 0;
    this.total = 0;
    return events;
  }

  /**
   * Authoritative recovery resolved/corrected a command revision: drop every
   * recorded conflict for that (fabId, commandId) at or below the authoritative
   * revision (a higher-revision conflict is still unresolved). Returns the number
   * of removed conflict records.
   */
  resolveAuthoritative(event: CommandResultEvent): number {
    let removed = 0;
    for (let index = this.conflictRecords.length - 1; index >= 0; index -= 1) {
      const conflict = this.conflictRecords[index];
      if (
        conflict.fabId === event.fabId &&
        conflict.commandId === event.commandId &&
        conflict.revision <= event.revision
      ) {
        this.conflictRecords.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Authoritative status query; a returned result is queued for the next retry
   * pass. The gateway returns a native Effect (ADR-011 §2.1): the caller owns the
   * approved execution boundary and passes it explicitly.
   */
  async reconcile(
    gateway: CommandGateway,
    fabId: string,
    commandId: string,
    run: (effect: Effect.Effect<CommandResultEvent | null, CommandGatewayError>) => Promise<CommandResultEvent | null>,
  ): Promise<CommandResultEvent | null> {
    const event = await run(gateway.getCommandStatus(fabId, commandId));
    if (event) this.hold(event);
    return event;
  }

  clear(): void {
    this.pending.clear();
    this.arrivals.length = 0;
    this.conflictRecords.length = 0;
    this.total = 0;
  }

  dispose(): void {
    this.clear();
  }

  /** Normal held events plus unresolved conflict records (the recovery barrier uses this). */
  get size(): number {
    return this.total + this.conflictRecords.length;
  }

  /** Unresolved same-revision outcome conflicts currently retained (Round 5.1 / P1-02). */
  get conflictCount(): number {
    return this.conflictRecords.length;
  }

  /** Bounded, oldest-first unresolved conflicts (diagnostics; never applied). */
  get conflicts(): readonly CommandRecoveryConflict[] {
    return this.conflictRecords;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Bounded, newest-first diagnostics for eviction observability. */
  get diagnostics(): readonly CommandRecoveryEviction[] {
    return this.evictions;
  }

  private evictOne(queue: HeldEvent[], key: string, reason: 'per-command' | 'global'): void {
    if (queue.length === 0) return;
    const index = reason === 'per-command'
      ? queue.reduce((oldest, held, current) => held.event.revision < queue[oldest].event.revision ? current : oldest, 0)
      : Math.max(0, queue.findIndex((held) => !isTerminal(held.event)));
    const [removed] = queue.splice(index, 1);
    this.removeArrival(removed.seq);
    this.total -= 1;
    if (queue.length === 0) this.pending.delete(key);
    this.report(removed.event, reason);
  }

  private evictGlobal(): void {
    if (this.arrivals.length === 0) return;
    const nonTerminal = this.arrivals.findIndex((held) => !isTerminal(held.event));
    const index = nonTerminal >= 0 ? nonTerminal : 0;
    const [removed] = this.arrivals.splice(index, 1);
    this.total -= 1;
    const key = keyOf(removed.event);
    const queue = this.pending.get(key);
    if (queue) {
      const indexInQueue = queue.findIndex((held) => held.seq === removed.seq);
      if (indexInQueue >= 0) queue.splice(indexInQueue, 1);
      if (queue.length === 0) this.pending.delete(key);
    }
    this.report(removed.event, 'global');
  }

  private report(event: CommandResultEvent, reason: 'per-command' | 'global'): void {
    this.dropped += 1;
    const eviction: CommandRecoveryEviction = {
      event,
      reason,
      terminal: isTerminal(event),
      droppedTotal: this.dropped,
    };
    this.evictions.push(eviction);
    if (this.evictions.length > CommandEventRecovery.MAX_DIAGNOSTICS) this.evictions.shift();
    this.onEvict?.(eviction);
  }

  private removeArrival(seq: number): void {
    const index = this.arrivals.findIndex((held) => held.seq === seq);
    if (index >= 0) this.arrivals.splice(index, 1);
  }
}
