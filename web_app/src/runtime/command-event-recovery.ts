import type { Effect } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import { resolveIntegerOption } from '@/contracts/command-config';

export interface CommandRecoveryOptions {
  /** Max held revisions per (fabId, commandId). */
  readonly maxPerCommand?: number;
  /** Max held revisions across all commands. */
  readonly maxTotal?: number;
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
 */
export class CommandEventRecovery {
  private readonly pending = new Map<string, HeldEvent[]>();
  /** Every held event in true global arrival order (the authoritative FIFO). */
  private readonly arrivals: HeldEvent[] = [];
  private nextSeq = 1;
  private total = 0;
  private readonly maxPerCommand: number;
  private readonly maxTotal: number;
  private readonly onEvict?: (eviction: CommandRecoveryEviction) => void;
  private dropped = 0;
  private readonly evictions: CommandRecoveryEviction[] = [];
  private static readonly MAX_DIAGNOSTICS = 16;

  constructor(options: CommandRecoveryOptions = {}) {
    this.maxPerCommand = resolveIntegerOption('recovery.maxPerCommand', options.maxPerCommand, 32, { min: 1 });
    this.maxTotal = resolveIntegerOption('recovery.maxTotal', options.maxTotal, 256, { min: 1 });
    this.onEvict = options.onEvict;
  }

  hold(event: CommandResultEvent): boolean {
    const key = keyOf(event);
    let queue = this.pending.get(key);
    if (!queue) {
      queue = [];
      this.pending.set(key, queue);
    }
    // Keep the newest revisions for one command: a duplicate/older event cannot
    // displace the current pending head unnecessarily. The replacement keeps the
    // total unchanged and takes the newest global arrival position.
    if (queue.some((held) => held.event.revision === event.revision)) return true;
    const held: HeldEvent = { event, seq: this.nextSeq++ };
    queue.push(held);
    this.arrivals.push(held);
    this.total += 1;
    while (queue.length > this.maxPerCommand) this.evictOne(queue, key, 'per-command');
    while (this.total > this.maxTotal) this.evictGlobal();
    return this.total > 0;
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
    this.total = 0;
  }

  dispose(): void {
    this.clear();
  }

  get size(): number {
    return this.total;
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
