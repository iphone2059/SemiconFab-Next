import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';

export interface CommandRecoveryOptions {
  /** Max held revisions per (fabId, commandId). */
  readonly maxPerCommand?: number;
  /** Max held revisions across all commands; the globally oldest event is dropped first. */
  readonly maxTotal?: number;
}

const keyOf = (event: Pick<CommandResultEvent, 'fabId' | 'commandId'>): string =>
  `${event.fabId}\u0000${event.commandId}`;

interface HeldEvent {
  readonly event: CommandResultEvent;
  /** Monotonic global arrival sequence: eviction and drain follow this, not command grouping. */
  readonly seq: number;
}

/**
 * Bounded pending queue for command results that arrive before their workflow
 * exists (WS confirmation before HTTP response, page re-mount, actor not created
 * yet). Durable recovery still belongs to the backend; this queue is an
 * in-memory bridge so important terminal results are not silently dropped.
 *
 * The queue keeps two indexes: a per-command queue for `pendingFor` and one
 * explicit global arrival list. Capacity eviction removes the true globally
 * oldest event (a long-lived command's older revisions no longer shield a newer
 * event of another command), and `drain` yields global arrival order.
 */
export class CommandEventRecovery {
  private readonly pending = new Map<string, HeldEvent[]>();
  /** Every held event in true global arrival order (the authoritative FIFO). */
  private readonly arrivals: HeldEvent[] = [];
  private nextSeq = 1;
  private total = 0;
  private readonly maxPerCommand: number;
  private readonly maxTotal: number;
  private dropped = 0;

  constructor(options: CommandRecoveryOptions = {}) {
    this.maxPerCommand = Math.max(1, options.maxPerCommand ?? 32);
    this.maxTotal = Math.max(1, options.maxTotal ?? 256);
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
    const sameRevision = queue.findIndex((held) => held.event.revision === event.revision);
    if (sameRevision >= 0) {
      const [previous] = queue.splice(sameRevision, 1);
      this.removeArrival(previous.seq);
      this.total -= 1;
    }
    const held: HeldEvent = { event, seq: this.nextSeq++ };
    queue.push(held);
    this.arrivals.push(held);
    this.total += 1;
    if (queue.length > this.maxPerCommand) {
      const removed = queue.splice(0, queue.length - this.maxPerCommand);
      for (const entry of removed) this.removeArrival(entry.seq);
      this.total -= removed.length;
      this.dropped += removed.length;
    }
    while (this.total > this.maxTotal) this.dropOldest();
    return this.total > 0;
  }

  pendingFor(fabId: string, commandId: string): readonly CommandResultEvent[] {
    const queue = this.pending.get(`${fabId}\u0000${commandId}`);
    return queue ? queue.map((held) => held.event) : [];
  }

  /** Drain all pending events in true global arrival order for a retry pass. */
  drain(): readonly CommandResultEvent[] {
    const events = this.arrivals.map((held) => held.event);
    this.pending.clear();
    this.arrivals.length = 0;
    this.total = 0;
    return events;
  }

  /** Authoritative status query; a returned result is queued for the next retry pass. */
  async reconcile(gateway: CommandGateway, fabId: string, commandId: string): Promise<CommandResultEvent | null> {
    const event = await gateway.getCommandStatus(fabId, commandId);
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

  private removeArrival(seq: number): void {
    const index = this.arrivals.findIndex((held) => held.seq === seq);
    if (index >= 0) this.arrivals.splice(index, 1);
  }

  /** Evict exactly the globally oldest held event from both indexes. */
  private dropOldest(): void {
    const oldest = this.arrivals.shift();
    if (!oldest) return;
    this.total -= 1;
    this.dropped += 1;
    const key = keyOf(oldest.event);
    const queue = this.pending.get(key);
    if (!queue) return;
    const index = queue.findIndex((held) => held.seq === oldest.seq);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
  }
}
