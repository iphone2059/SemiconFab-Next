import { setup, types } from 'xstate';
export const twinResearchMachine = setup({
  schemas: {
    events: {
      ENTER: types<{}>(),
      READY: types<{}>(),
      FAIL: types<{}>(),
      EXIT: types<{}>(),
      PLAY: types<{}>(),
      PAUSE: types<{}>(),
      SEEK: types<{}>(),
      COMPLETE: types<{}>(),
    },
  },
}).createMachine({
  id: 'twinResearch',
  initial: 'inactive',
  states: {
    inactive: { on: { ENTER: { target: 'loading' } } },
    loading: { on: { READY: { target: 'paused' }, FAIL: { target: 'failed' }, EXIT: { target: 'inactive' } } },
    paused: { on: { PLAY: { target: 'playing' }, SEEK: { target: 'paused' }, EXIT: { target: 'inactive' } } },
    playing: { on: { PAUSE: { target: 'paused' }, SEEK: { target: 'paused' }, COMPLETE: { target: 'completed' }, EXIT: { target: 'inactive' } } },
    completed: { on: { PLAY: { target: 'playing' }, SEEK: { target: 'paused' }, EXIT: { target: 'inactive' } } },
    failed: { on: { EXIT: { target: 'inactive' } } },
  },
});