import { createActor, type Actor } from 'xstate';
import type { CommandResultEvent } from '../../application/contracts/CommandEvents';
import type { CommandWorkflow, CommandWorkflowProjection } from '../../application/contracts/CommandWorkflow';
import { CommandReconciler } from './CommandReconciler';
import {
  isTerminalState,
  type EquipmentCommandContext,
  type EquipmentCommandState,
} from './equipmentCommand.logic';
import { equipmentCommandMachine } from './equipmentCommand.machine';

type EquipmentMachine = typeof equipmentCommandMachine;

/**
 * XState v6 implementation hidden behind the public CommandWorkflow contract.
 * The adapter enforces monotonic revisions before forwarding to the actor and
 * exposes read-only state/context for the runtime/tests. XState is never
 * imported outside the workflows layer (ARCH-08).
 */
export class XStateCommandWorkflowAdapter implements CommandWorkflow {
  private readonly actor: Actor<EquipmentMachine>;
  private readonly reconciler?: CommandReconciler;

  constructor(
    readonly fabId: string,
    readonly commandId: string,
    reconciler?: CommandReconciler,
  ) {
    this.actor = createActor(equipmentCommandMachine, { input: { fabId, commandId } });
    this.reconciler = reconciler;
    this.actor.start();
  }

  receive(event: CommandResultEvent): void {
    const snapshot = this.actor.getSnapshot();
    if (isTerminalState(String(snapshot.value) as EquipmentCommandState)) return;
    if (!Number.isInteger(event.revision) || event.revision <= snapshot.context.revision) return;
    this.actor.send({ type: 'RESULT', event });
  }

  async reconcile(commandId: string): Promise<void> {
    if (!this.reconciler) return;
    await this.reconciler.reconcile(this, this.fabId, commandId);
  }

  dispose(): void {
    this.actor.stop();
  }

  get state(): EquipmentCommandState {
    return String(this.actor.getSnapshot().value) as EquipmentCommandState;
  }

  get context(): EquipmentCommandContext {
    return this.actor.getSnapshot().context;
  }

  get isTerminal(): boolean {
    return isTerminalState(this.state);
  }

  get projection(): CommandWorkflowProjection {
    const snapshot = this.actor.getSnapshot();
    return {
      state: this.state,
      revision: snapshot.context.revision,
      outcome: snapshot.context.outcome,
    };
  }
}
