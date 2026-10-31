import { setup, types } from 'xstate';
import type { WaferProduct } from '@/domain/wafer-route';
export type TwinWaferSpeed = 1 | 4 | 16;
export interface TwinWaferMachineContext {
  readonly product: WaferProduct;
  readonly speed: TwinWaferSpeed;
  readonly index: number;
  readonly routesReady: boolean;
}
const waferSetup = setup({
  schemas: {
    context: types<TwinWaferMachineContext>(),
    events: {
      RESTORE: types<{ product: WaferProduct; speed: TwinWaferSpeed }>(),
      OPEN: types<{}>(),
      CLOSE: types<{}>(),
      ROUTES_READY: types<{}>(),
      TOGGLE: types<{}>(),
      PRODUCT: types<{ product: WaferProduct }>(),
      SPEED: types<{ speed: TwinWaferSpeed }>(),
      WAYPOINT: types<{ index: number }>(),
      COMPLETE: types<{}>(),
      REPLAY: types<{}>(),
    },
  },
});
export const twinWaferMachine = waferSetup.createMachine({
  id: 'twinWafer',
  initial: 'closed',
  context: () => ({ product: 'A', speed: 1, index: 0, routesReady: false }),
  states: {
    closed: {
      on: {
        RESTORE: ({ context, event }) => ({ target: 'closed', context: { ...context, product: event.product, speed: event.speed, index: 0 } }),
        OPEN: ({ context }) => ({ target: context.routesReady ? 'playing' : 'loading' }),
        ROUTES_READY: ({ context }) => ({ target: 'closed', context: { ...context, routesReady: true } }),
        PRODUCT: ({ context, event }) => ({ target: 'closed', context: { ...context, product: event.product, index: 0 } }),
        SPEED: ({ context, event }) => ({ target: 'closed', context: { ...context, speed: event.speed } }),
      },
    },
    loading: {
      on: {
        ROUTES_READY: ({ context }) => ({ target: 'playing', context: { ...context, routesReady: true } }),
        CLOSE: { target: 'closed' },
        PRODUCT: ({ context, event }) => ({ target: 'loading', context: { ...context, product: event.product, index: 0 } }),
        SPEED: ({ context, event }) => ({ target: 'loading', context: { ...context, speed: event.speed } }),
      },
    },
    playing: {
      on: {
        CLOSE: { target: 'closed' },
        TOGGLE: { target: 'paused' },
        PRODUCT: ({ context, event }) => ({ target: 'playing', context: { ...context, product: event.product, index: 0 } }),
        SPEED: ({ context, event }) => ({ target: 'playing', context: { ...context, speed: event.speed } }),
        WAYPOINT: ({ context, event }) => ({ target: 'playing', context: { ...context, index: event.index } }),
        COMPLETE: { target: 'completed' },
        REPLAY: ({ context }) => ({ target: 'playing', context: { ...context, index: 0 } }),
      },
    },
    paused: {
      on: {
        CLOSE: { target: 'closed' },
        TOGGLE: { target: 'playing' },
        PRODUCT: ({ context, event }) => ({ target: 'playing', context: { ...context, product: event.product, index: 0 } }),
        SPEED: ({ context, event }) => ({ target: 'paused', context: { ...context, speed: event.speed } }),
        WAYPOINT: ({ context, event }) => ({ target: 'paused', context: { ...context, index: event.index } }),
        REPLAY: ({ context }) => ({ target: 'playing', context: { ...context, index: 0 } }),
      },
    },
    completed: {
      on: {
        CLOSE: { target: 'closed' },
        TOGGLE: { target: 'playing' },
        PRODUCT: ({ context, event }) => ({ target: 'playing', context: { ...context, product: event.product, index: 0 } }),
        SPEED: ({ context, event }) => ({ target: 'completed', context: { ...context, speed: event.speed } }),
        WAYPOINT: ({ context, event }) => ({ target: 'completed', context: { ...context, index: event.index } }),
        REPLAY: ({ context }) => ({ target: 'playing', context: { ...context, index: 0 } }),
      },
    },
  },
});
