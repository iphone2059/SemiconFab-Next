import { setup, types } from 'xstate';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import {
  stateForOutcome,
  type EquipmentCommandContext,
  type EquipmentCommandState,
} from '@/runtime/equipment-command.logic';

export interface EquipmentCommandInput {
  readonly fabId: string;
  readonly commandId: string;
}

const commandSetup = setup({
  schemas: {
    context: types<EquipmentCommandContext>(),
    input: types<EquipmentCommandInput>(),
    events: {
      // The event key is the event type; the schema describes the payload only.
      RESULT: types<{ event: CommandResultEvent }>(),
    },
  },
});

/**
 * XState v6 statechart for one equipment command. The machine is a static,
 * reusable definition; per-command identity enters through actor input, per the
 * v6 input-schema pattern. States mirror authoritative command outcomes and
 * terminal states are final. Stale revisions are ignored by the transition
 * function (the adapter also filters before send for the external contract).
 */
export const equipmentCommandMachine = commandSetup.createMachine({
  id: 'equipmentCommand',
  initial: 'idle',
  context: ({ input }) => ({
    fabId: input.fabId,
    commandId: input.commandId,
    revision: -1,
    outcome: 'pending',
  }),
  states: {
    idle: {
      on: {
        RESULT: ({ context, event }) => transition(context, event.event),
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
