import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createDemoState, demoReducer, type DemoState } from '../twin-equipment';
import { YIELD_SCENARIOS } from '../fab-yield';
import type { FabToolState } from '../fab-layout';

const baseline = YIELD_SCENARIOS[0];
const initialDemo = demoReducer(createDemoState(42), { type: 'scenario', scenario: baseline });

function reduce(state: DemoState, event: Parameters<typeof demoReducer>[1]): DemoState {
  return demoReducer(state, event);
}

export const twinDemoSlice = createSlice({
  name: 'twinDemo',
  initialState: initialDemo,
  reducers: {
    tick(state) { return reduce(state, { type: 'tick' }); },
    playingSet(state, action: PayloadAction<boolean>) { return reduce(state, { type: 'play', playing: action.payload }); },
    manualStateSet(state, action: PayloadAction<{ index: number; state: FabToolState }>) { return reduce(state, { type: 'manual', ...action.payload }); },
    manualKeySet(state, action: PayloadAction<{ key: string; state: FabToolState }>) { return reduce(state, { type: 'manual-key', ...action.payload }); },
    scenarioApplied(state, action: PayloadAction<typeof baseline>) { return reduce(state, { type: 'scenario', scenario: action.payload }); },
  },
});

export const twinDemoActions = twinDemoSlice.actions;
