import { Effect, Exit, Scope } from 'effect';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';

export type CommandWorkflowFactory = (fabId: string, commandId: string) => CommandWorkflow;

export interface CommandWorkflowScope {
  /** Create a workflow inside the owned Scope; its dispose runs when the Scope closes. */
  acquire(factory: CommandWorkflowFactory, fabId: string, commandId: string): CommandWorkflow;
  close(): void;
  readonly closed: boolean;
}

/**
 * Task 4 stage B: Effect owns the command actor/resource lifetime even though the
 * XState adapter is consumed synchronously by the bridge. Every workflow is
 * acquired with Effect.acquireRelease into one Scope; FabRuntime.dispose closes
 * that Scope, which stops actors and runs their finalizers exactly once.
 */
export class EffectCommandWorkflowScope implements CommandWorkflowScope {
  private readonly scope = Effect.runSync(Scope.make());
  private isClosed = false;

  acquire(factory: CommandWorkflowFactory, fabId: string, commandId: string): CommandWorkflow {
    if (this.isClosed) throw new Error('Command workflow scope is already closed');
    return Effect.runSync(
      Effect.provideService(
        Effect.acquireRelease(
          Effect.sync(() => factory(fabId, commandId)),
          (workflow) => Effect.sync(() => workflow.dispose()),
        ),
        Scope.Scope,
        this.scope,
      ),
    );
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // All finalizers are synchronous adapter/actor stops; Effect.runSync keeps the
    // existing synchronous FabRuntime.dispose contract while still owning them by Scope.
    Effect.runSync(Scope.close(this.scope, Exit.void));
  }

  get closed(): boolean {
    return this.isClosed;
  }
}
