import type { CommandGateway } from '../contracts/CommandGateway';
import type { CommandResultEvent } from '../contracts/CommandEvents';

export interface CommandRecoveryOptions {
  /** Max held revisions per (fabId, commandId). */
  readonly maxPerCommand?: number;
  /** Max held revisions across all commands; oldest entries are dropped first. */
  readonly maxTotal?: number;
}

const keyOf = (event: Pick<CommandResultEvent, 'fabId' | 'commandId'>): string =>
  `${event.fabId}\u0000${event.commandId}`;

/**
 * Bounded pending queue for command results that arrive before their workflow
 * exists (WS confirmation before HTTP response, page re-mount, actor not created
 * yet). Durable recovery still belongs to the backend; this queue is an
 * in-memory bridge so important terminal results are not silently dropped.
 */
export class CommandEventRecovery {
  private readonly pending = new Map<string, CommandResultEvent[]>();
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
    // displace the current pending head unnecessarily.
    const sameRevision = queue.findIndex((value) => value.revision === event.revision);
    if (sameRevision >= 0) queue.splice(sameRevision, 1);
    else this.total += 1;
    queue.push(event);
    if (queue.length > this.maxPerCommand) {
      this.total -= queue.length - this.maxPerCommand;
      this.dropped += queue.length - this.maxPerCommand;
      queue.splice(0, queue.length - this.maxPerCommand);
    }
    while (this.total > this.maxTotal) {
      this.dropOldest();
    }
    return this.total > 0;
  }

  pendingFor(fabId: string, commandId: string): readonly CommandResultEvent[] {
    return this.pending.get(`${fabId}\u0000${commandId}`) ?? [];
  }

  /** Drain all pending events in arrival order for a retry pass. */
  drain(): readonly CommandResultEvent[] {
    const events: CommandResultEvent[] = [];
    for (const queue of this.pending.values()) events.push(...queue);
    this.pending.clear();
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

  private dropOldest(): void {
    for (const [key, queue] of this.pending) {
      if (queue.length === 0) {
        this.pending.delete(key);
        continue;
      }
      queue.shift();
      this.total -= 1;
      this.dropped += 1;
      if (queue.length === 0) this.pending.delete(key);
      return;
    }
  }
}
