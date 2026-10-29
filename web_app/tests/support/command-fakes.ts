import { Effect, PubSub, Stream } from 'effect';
import type { CommandConnectionStatus, CommandEventSource, CommandOutcome, CommandResultEvent, CommandStreamGap, CommandTransportFailure } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';

export class FakeCommandWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];
  readonly reconciled: string[] = [];
  disposed = false;

  receive(event: CommandResultEvent): void {
    this.events.push(event);
  }

  async reconcile(commandId: string): Promise<void> {
    this.reconciled.push(commandId);
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeWorkflowRegistry implements CommandWorkflowRegistry {
  private readonly workflows = new Map<string, CommandWorkflow>();

  private static key(fabId: string, commandId: string): string {
    return `${fabId}\u0000${commandId}`;
  }

  register(fabId: string, commandId: string, workflow: CommandWorkflow): void {
    this.workflows.set(FakeWorkflowRegistry.key(fabId, commandId), workflow);
  }

  get(fabId: string, commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(FakeWorkflowRegistry.key(fabId, commandId));
  }
}

/**
 * Effect-Stream command source for tests. Every signal is a real Stream fed by a
 * PubSub; observer counters are incremented by Stream lifecycle effects so tests
 * can assert that a disposed runtime detached all stream consumers.
 */
export class FakeCommandEventSource implements CommandEventSource {
  private readonly resultsBus = Effect.runSync(PubSub.unbounded<CommandResultEvent>());
  private readonly reconnectBus = Effect.runSync(PubSub.unbounded<void>());
  private readonly gapBus = Effect.runSync(PubSub.unbounded<CommandStreamGap>());
  private readonly failureBus = Effect.runSync(PubSub.unbounded<CommandTransportFailure>());
  private readonly statusBus = Effect.runSync(PubSub.unbounded<CommandConnectionStatus>());
  private resultCount = 0;
  private reconnectCount = 0;
  private gapCount = 0;
  private failureCount = 0;
  private statusCount = 0;

  private countStream<A>(bus: PubSub.PubSub<A>, counters: { increment: () => void; decrement: () => void }): Stream.Stream<A> {
    return Stream.fromPubSub(bus).pipe(
      Stream.onStart(Effect.sync(counters.increment)),
      Stream.ensuring(Effect.sync(counters.decrement)),
    );
  }

  readonly commandResults = this.countStream(this.resultsBus, {
    increment: () => { this.resultCount += 1; },
    decrement: () => { this.resultCount = Math.max(0, this.resultCount - 1); },
  });
  readonly reconnected = this.countStream(this.reconnectBus, {
    increment: () => { this.reconnectCount += 1; },
    decrement: () => { this.reconnectCount = Math.max(0, this.reconnectCount - 1); },
  });
  readonly gaps = this.countStream(this.gapBus, {
    increment: () => { this.gapCount += 1; },
    decrement: () => { this.gapCount = Math.max(0, this.gapCount - 1); },
  });
  readonly transportFailures = this.countStream(this.failureBus, {
    increment: () => { this.failureCount += 1; },
    decrement: () => { this.failureCount = Math.max(0, this.failureCount - 1); },
  });
  readonly connectionStatus = this.countStream(this.statusBus, {
    increment: () => { this.statusCount += 1; },
    decrement: () => { this.statusCount = Math.max(0, this.statusCount - 1); },
  });

  reconnect(): void { PubSub.publishUnsafe(this.reconnectBus, undefined); }

  /** Signal that backend replay could not cover a disconnect. */
  emitGap(gap: CommandStreamGap = { epoch: 'epoch-1', sequence: 7 }): void { PubSub.publishUnsafe(this.gapBus, gap); }

  /** Simulate an EventSource transport interruption (never a command outcome). */
  failTransport(failure: CommandTransportFailure = { message: 'transport failure' }): void {
    PubSub.publishUnsafe(this.statusBus, 'reconnecting');
    PubSub.publishUnsafe(this.failureBus, failure);
  }

  openStream(): void { PubSub.publishUnsafe(this.statusBus, 'open'); }

  get failureObservers(): number { return this.failureCount; }
  get commandObservers(): number { return this.resultCount; }
  get reconnectObservers(): number { return this.reconnectCount; }
  get gapObservers(): number { return this.gapCount; }
  get statusObservers(): number { return this.statusCount; }

  emit(event: CommandResultEvent): void {
    PubSub.publishUnsafe(this.resultsBus, event);
  }

  /** Ends the live command stream; the bridge stops consuming it. */
  complete(): void {
    Effect.runSync(PubSub.shutdown(this.resultsBus));
  }
}

export function commandResult(
  input: { fabId: string; commandId: string; revision: number; outcome: CommandOutcome; occurredAt?: string },
): CommandResultEvent {
  return { occurredAt: '2026-10-27T00:00:00.000Z', ...input };
}
