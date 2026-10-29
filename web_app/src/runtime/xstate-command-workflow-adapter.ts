import { createActor, type Actor } from 'xstate';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
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

  private started = false;

  constructor(
    readonly fabId: string,
    readonly commandId: string,
  ) {
    this.actor = createActor(equipmentCommandMachine, { input: { fabId, commandId } });
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

  /**
   * The public CommandWorkflow contract keeps reconcile() for direct adapter
   * users, but ADR-011 §2.2 makes the FabReconciliationScheduler the only
   * authoritative path (it owns the reconciler, request generation guard, real
   * timeout and the shared physical budget). The adapter is therefore not an
   * authority and performs no network work.
   */
  async reconcile(_commandId: string): Promise<void> {}


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
