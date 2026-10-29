import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';

/** Read-only projection of workflow state for UI display; never a second authority. */
export interface CommandWorkflowProjection {
  readonly state: string;
  readonly revision: number;
  readonly outcome: CommandOutcome | 'pending';
}

/**
 * Public workflow contract. XState (or any other implementation) is injected by
 * the Runtime behind this interface; realtime/application code never imports an
 * actor implementation (ARCH-08).
 */
export interface CommandWorkflow {
  receive(event: CommandResultEvent): void;
  reconcile(commandId: string): Promise<void>;
  dispose(): void;
  /** Optional read-only projection; the UI must not write it back. */
  readonly projection?: CommandWorkflowProjection;
}

export interface CommandWorkflowRegistry {
  get(fabId: string, commandId: string): CommandWorkflow | undefined;
}
