import { Subject } from 'rxjs';
import type { CommandEventSource, CommandOutcome, CommandResultEvent } from '../../src/application/contracts/CommandEvents';
import type { CommandWorkflow, CommandWorkflowRegistry } from '../../src/application/contracts/CommandWorkflow';

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

export class FakeCommandEventSource implements CommandEventSource {
  private readonly subject = new Subject<CommandResultEvent>();
  readonly commandResult$ = this.subject.asObservable();

  emit(event: CommandResultEvent): void {
    this.subject.next(event);
  }

  complete(): void {
    this.subject.complete();
  }
}

export function commandResult(
  input: { fabId: string; commandId: string; revision: number; outcome: CommandOutcome; occurredAt?: string },
): CommandResultEvent {
  return { occurredAt: '2026-10-27T00:00:00.000Z', ...input };
}
