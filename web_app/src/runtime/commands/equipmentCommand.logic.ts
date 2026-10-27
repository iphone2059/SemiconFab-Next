import type { CommandOutcome, CommandResultEvent } from '../../application/contracts/CommandEvents';

export type EquipmentCommandState = 'idle' | 'accepted' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
export type EquipmentCommandOutcome = CommandOutcome | 'pending';

export interface EquipmentCommandContext {
  readonly fabId: string;
  readonly commandId: string;
  readonly revision: number;
  readonly outcome: EquipmentCommandOutcome;
  readonly lastEvent?: CommandResultEvent;
}

const TERMINAL: ReadonlySet<EquipmentCommandState> = new Set(['succeeded', 'failed', 'cancelled']);

/** Pure mapping used by the machine and by tests. */
export function stateForOutcome(outcome: EquipmentCommandOutcome): EquipmentCommandState {
  switch (outcome) {
    case 'accepted': return 'accepted';
    case 'executing': return 'executing';
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'idle';
  }
}

export function isTerminalState(state: EquipmentCommandState): boolean {
  return TERMINAL.has(state);
}

export function isNewerRevision(current: number, next: number): boolean {
  return Number.isInteger(next) && next > current;
}

export function applyCommandResult(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): { state: EquipmentCommandState; context: EquipmentCommandContext } | undefined {
  if (!isNewerRevision(context.revision, event.revision)) return undefined;
  return {
    state: stateForOutcome(event.outcome),
    context: {
      ...context,
      revision: event.revision,
      outcome: event.outcome,
      lastEvent: event,
    },
  };
}
