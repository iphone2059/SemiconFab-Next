import { setup, types } from 'xstate';
import type { CommandResultEvent } from '../../application/contracts/CommandEvents';
import {
  stateForOutcome,
  type EquipmentCommandContext,
  type EquipmentCommandState,
} from './equipmentCommand.logic';

export type EquipmentCommandEvent =
  | { readonly type: 'RESULT'; readonly event: CommandResultEvent }
  | { readonly type: 'RECONCILE'; readonly event: CommandResultEvent | null };

const commandSetup = setup({
  schemas: {
    context: types<EquipmentCommandContext>(),
    events: {
      RESULT: types<{ type: 'RESULT'; event: CommandResultEvent }>(),
      RECONCILE: types<{ type: 'RECONCILE'; event: CommandResultEvent | null }>(),
    },
  },
});

/**
 * XState v6 statechart for one equipment command. The adapter enforces
 * monotonic revisions before sending RESULT; states mirror the authoritative
 * command outcomes and terminal states are final.
 */
export function createEquipmentCommandMachine(fabId: string, commandId: string) {
  return commandSetup.createMachine({
    id: 'equipmentCommand',
    initial: 'idle',
    context: {
      fabId,
      commandId,
      revision: -1,
      outcome: 'pending',
    } satisfies EquipmentCommandContext,
    states: {
      idle: {
        on: {
          RESULT: ({ context, event }) => transition(context, event.event),
          RECONCILE: ({ context, event }) => (event.event ? transition(context, event.event) : undefined),
        },
      },
      accepted: {
        on: {
          RESULT: ({ context, event }) => transition(context, event.event),
        },
      },
      executing: {
        on: {
          RESULT: ({ context, event }) => transition(context, event.event),
        },
      },
      succeeded: { type: 'final' },
      failed: { type: 'final' },
      cancelled: { type: 'final' },
    },
  });
}

/** Returns a v6 transition patch: target plus the partial context update. */
function transition(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): { target: EquipmentCommandState; context: Partial<EquipmentCommandContext> } | undefined {
  if (!Number.isInteger(event.revision) || event.revision <= context.revision) return undefined;
  return {
    target: stateForOutcome(event.outcome),
    context: {
      revision: event.revision,
      outcome: event.outcome,
      lastEvent: event,
    },
  };
}
