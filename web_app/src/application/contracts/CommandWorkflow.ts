import type { CommandResultEvent } from './CommandEvents';

/**
 * Public workflow contract. XState (or any other implementation) is injected by
 * the Runtime behind this interface; realtime/application code never imports an
 * actor implementation (ARCH-08).
 */
export interface CommandWorkflow {
  receive(event: CommandResultEvent): void;
  reconcile(commandId: string): Promise<void>;
  dispose(): void;
}

export interface CommandWorkflowRegistry {
  get(fabId: string, commandId: string): CommandWorkflow | undefined;
}
