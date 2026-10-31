import { setup, types } from 'xstate';
export interface TwinTourMachineContext {
  readonly waypoint: number;
}
const twinTourSetup = setup({
  schemas: {
    context: types<TwinTourMachineContext>(),
    events: {
      START: types<{}>(),
      WAYPOINT: types<{ waypoint: number }>(),
      STOP: types<{}>(),
    },
  },
});
export const twinTourMachine = twinTourSetup.createMachine({
  id: 'twinTour',
  initial: 'idle',
  context: () => ({ waypoint: 0 }),
  states: {
    idle: {
      on: {
        START: ({ context }) => ({ target: 'running', context: { ...context, waypoint: 0 } }),
      },
    },
    running: {
      on: {
        START: ({ context }) => ({ target: 'running', context: { ...context, waypoint: 0 } }),
        WAYPOINT: ({ context, event }) => ({ target: 'running', context: { ...context, waypoint: event.waypoint } }),
        STOP: { target: 'idle' },
      },
    },
  },
});
