import { createActor, type Actor } from 'xstate';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import { CommandReconciler } from '@/runtime/command-reconciler';
import {
  isTerminalState,
  type EquipmentCommandContext,
  type EquipmentCommandState,
} from '@/runtime/equipment-command.logic';
import { equipmentCommandMachine } from '@/runtime/equipment-command.machine';

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

  private started = false;

  constructor(
    readonly fabId: string,
    readonly commandId: string,
    reconciler?: CommandReconciler,
  ) {
    this.actor = createActor(equipmentCommandMachine, { input: { fabId, commandId } });
    this.reconciler = reconciler;
  }

  /**
   * Start is explicit so the owner can seed the initial projection and subscribe
   * before the actor emits its first snapshot (Task 4 actor lifecycle contract).
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.actor.start();
  }

  /** Read-only snapshot subscription; the owner must unsubscribe before stopping. */
  subscribe(listener: () => void): () => void {
    const subscription = this.actor.subscribe(() => listener());
    return () => subscription.unsubscribe();
  }

  receive(event: CommandResultEvent): void {
    // Direct adapter users (contract tests) may not call start explicitly.
    this.start();
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
    if (!this.started) return;
    this.started = false;
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
