import { setup, types } from 'xstate';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
import {
  stateForOutcome,
  type EquipmentCommandContext,
  type EquipmentCommandState,
} from '@/runtime/equipment-command.logic';

export interface EquipmentCommandInput {
  readonly fabId: string;
  readonly commandId: string;
}

/** The five business outcomes; `pending` is a client projection only, never an event outcome. */
const OUTCOMES: ReadonlySet<string> = new Set<CommandOutcome>([
  'accepted',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * One transition either applies a validated event (target + partial context) or
 * is rejected by returning undefined, which XState treats as "no transition".
 */
interface TransitionPatch {
  readonly target: EquipmentCommandState;
  readonly context: Partial<EquipmentCommandContext>;
}

const commandSetup = setup({
  schemas: {
    context: types<EquipmentCommandContext>(),
    input: types<EquipmentCommandInput>(),
    events: {
      // The event key is the event type; the schema describes the payload only.
      //
      // Round 5.1 / P1-03: the *source* of a result decides its channel. There is
      // no generic RESULT event, so a realtime frame can never masquerade as an
      // authoritative record (and vice versa) even if a caller re-delivers it.
      RESULT_REALTIME: types<{ event: CommandResultEvent }>(),
      RESULT_AUTHORITATIVE: types<{ event: CommandResultEvent }>(),
      EXPIRE: types<{}>(),
    },
  },
});

/**
 * XState v6 statechart for one equipment command. The machine is a static,
 * reusable definition; per-command identity enters through actor input, per the
 * v6 input-schema pattern.
 *
 * Round 5.1 / P1-03 source isolation:
 * - `RESULT_REALTIME` is a live SSE observation: it is strictly monotonic, never
 *   revives `expired` and never seals/corrects a terminal projection.
 * - `RESULT_AUTHORITATIVE` is a validated List/Journal record: it never rolls the
 *   revision back, may resolve `expired` (equal revision included), and may
 *   correct a wrong local projection - including a same-revision outcome
 *   correction of a terminal state. Terminal states are therefore NOT XState
 *   `final` states (spec §5.2); finality here is a domain projection, not a
 *   structural guarantee.
 * - `expired` is a client recovery state, not a business outcome: realtime can
 *   never leave it, only validated authority can.
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
        RESULT_REALTIME: ({ context, event }) => realtimeFromActive(context, event.event),
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromActive(context, event.event),
        EXPIRE: { target: 'expired' },
      },
    },
    accepted: {
      on: {
        RESULT_REALTIME: ({ context, event }) => realtimeFromActive(context, event.event),
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromActive(context, event.event),
        EXPIRE: { target: 'expired' },
      },
    },
    executing: {
      on: {
        RESULT_REALTIME: ({ context, event }) => realtimeFromActive(context, event.event),
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromActive(context, event.event),
        EXPIRE: { target: 'expired' },
      },
    },
    expired: {
      on: {
        // P1-03 core: a realtime frame NEVER exits expired and NEVER mutates the
        // retained revision/outcome/lastEvent - regardless of its revision.
        RESULT_REALTIME: () => undefined,
        // Only a validated authoritative record may resolve or correct the state.
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromExpired(context, event.event),
        // Recovery observing another authoritative miss keeps the client state.
        EXPIRE: { target: 'expired' },
      },
    },
    // Terminal projections are deliberately not final (spec §5.2): authoritative
    // correction must be able to replace a wrong outcome.
    succeeded: {
      on: {
        RESULT_REALTIME: () => undefined,
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromTerminal(context, event.event),
      },
    },
    failed: {
      on: {
        RESULT_REALTIME: () => undefined,
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromTerminal(context, event.event),
      },
    },
    cancelled: {
      on: {
        RESULT_REALTIME: () => undefined,
        RESULT_AUTHORITATIVE: ({ context, event }) => authoritativeFromTerminal(context, event.event),
      },
    },
  },
});

/**
 * Protocol validation shared by both channels: a result must belong to this
 * command, carry a non-negative integer revision and a real business outcome.
 * Identity validation is mandatory for authoritative records; realtime delivery
 * is FAB-filtered upstream, but rejecting foreign identity here keeps a direct
 * adapter call from corrupting another command's projection.
 */
function isValidEvent(context: EquipmentCommandContext, event: CommandResultEvent): boolean {
  return event.fabId === context.fabId
    && event.commandId === context.commandId
    && Number.isInteger(event.revision)
    && event.revision >= 0
    && OUTCOMES.has(event.outcome);
}

/** The single place that writes projected command state. */
function applyEvent(event: CommandResultEvent): TransitionPatch {
  return {
    target: stateForOutcome(event.outcome),
    context: {
      revision: event.revision,
      outcome: event.outcome,
      lastEvent: event,
    },
  };
}

/**
 * Active states (idle/accepted/executing) + realtime: strictly monotonic only.
 * Equal or lower revisions, including a same-revision conflicting outcome, are
 * left to the correlation/conflict layer and authoritative recovery.
 */
function realtimeFromActive(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): TransitionPatch | undefined {
  if (!isValidEvent(context, event)) return undefined;
  if (event.revision <= context.revision) return undefined;
  return applyEvent(event);
}

/**
 * Active states + authoritative: forward revision applies; an equal revision is
 * a correction (different outcome) or a duplicate no-op (same outcome). Never a
 * rollback.
 */
function authoritativeFromActive(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): TransitionPatch | undefined {
  if (!isValidEvent(context, event)) return undefined;
  if (event.revision < context.revision) return undefined;
  if (event.revision === context.revision && event.outcome === context.outcome) return undefined;
  return applyEvent(event);
}

/**
 * Expired + authoritative: any validated revision >= the retained revision
 * resolves the client recovery state. Equal revision with the retained outcome
 * is a duplicate resolution; equal revision with another outcome is an
 * authoritative correction; a higher revision is a newer authoritative record.
 * Lower revisions never roll back.
 */
function authoritativeFromExpired(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): TransitionPatch | undefined {
  if (!isValidEvent(context, event)) return undefined;
  if (event.revision < context.revision) return undefined;
  return applyEvent(event);
}

/**
 * Terminal + authoritative: a higher revision applies; an equal revision with a
 * different outcome replaces the wrong terminal projection at the same revision
 * (authoritative correction); an equal revision with the same outcome is a
 * no-op; a lower revision never rolls back.
 */
function authoritativeFromTerminal(
  context: EquipmentCommandContext,
  event: CommandResultEvent,
): TransitionPatch | undefined {
  if (!isValidEvent(context, event)) return undefined;
  if (event.revision < context.revision) return undefined;
  if (event.revision === context.revision && event.outcome === context.outcome) return undefined;
  return applyEvent(event);
}
