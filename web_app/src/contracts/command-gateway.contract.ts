import type { CommandResultEvent } from '@/contracts/command-events.contract';

/** Authoritative command-status query used for recovery after missed events. */
export interface CommandGateway {
  getCommandStatus(fabId: string, commandId: string): Promise<CommandResultEvent | null>;
}
