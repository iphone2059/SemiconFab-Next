import { create } from 'zustand';
import { createDemoState, demoReducer, type DemoState } from '../twin-equipment';
import { YIELD_SCENARIOS } from '../fab-yield';
import type { FabToolState } from '../fab-layout';

const baseline = YIELD_SCENARIOS[0];
// initDigitalTwinEngine initializes once; selecting a Scenario is a later event.
export const initialTwinDemoState: DemoState = createDemoState(42);

export const useTwinDemoStore = create<DemoState>()(() => initialTwinDemoState);

const reduce = (event: Parameters<typeof demoReducer>[1]): void => {
  useTwinDemoStore.setState((state) => demoReducer(state, event));
};

export const twinDemoActions = {
  tick: () => reduce({ type: 'tick' }),
  playingSet: (playing: boolean) => reduce({ type: 'play', playing }),
  manualStateSet: (payload: { index: number; state: FabToolState }) => reduce({ type: 'manual', ...payload }),
  manualKeySet: (payload: { key: string; state: FabToolState }) => reduce({ type: 'manual-key', ...payload }),
  scenarioApplied: (scenario: typeof baseline) => reduce({ type: 'scenario', scenario }),
};

export const resetTwinDemoStore = (): void => useTwinDemoStore.setState(createDemoState(42), true);
