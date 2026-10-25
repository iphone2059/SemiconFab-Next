import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { HoveredTool } from '../fab-scene';

const preparing = '准备 WebGPU 视图…';
interface RuntimeState {
  viewer: { epoch?: string; generation: number; status: string; hover?: HoveredTool; selectionSync?: string };
  fatalError?: string;
}
const initialState: RuntimeState = { viewer: { generation: 0, status: preparing } };
export const runtimeSlice = createSlice({
  name: 'runtime', initialState,
  reducers: {
    viewerMounted(state, action: PayloadAction<string>) {
      state.viewer.epoch = action.payload;
      state.viewer.status = preparing;
      state.viewer.hover = undefined;
      state.viewer.selectionSync = undefined;
    },
    viewerStatusReceived(state, action: PayloadAction<{ epoch: string; status: string }>) {
      if (state.viewer.epoch === action.payload.epoch) state.viewer.status = action.payload.status;
    },
    viewerHoverReceived(state, action: PayloadAction<{ epoch: string; hover?: HoveredTool }>) {
      if (state.viewer.epoch === action.payload.epoch) state.viewer.hover = action.payload.hover;
    },
    viewerHoverCleared(state) { state.viewer.hover = undefined; },
    viewerSelectionSyncStarted(state, action: PayloadAction<string>) { state.viewer.selectionSync = action.payload; },
    viewerSelectionSyncFinished(state, action: PayloadAction<string>) {
      if (state.viewer.selectionSync === action.payload) state.viewer.selectionSync = undefined;
    },
    viewerReloadRequested(state) {
      state.viewer.generation++;
      state.viewer.epoch = undefined;
      state.viewer.status = preparing;
      state.viewer.hover = undefined;
      state.viewer.selectionSync = undefined;
    },
    viewerUnmounted(state, action: PayloadAction<string>) {
      if (state.viewer.epoch !== action.payload) return;
      state.viewer.epoch = undefined;
      state.viewer.status = preparing;
      state.viewer.hover = undefined;
      state.viewer.selectionSync = undefined;
    },
    fatalErrorSet(state, action: PayloadAction<string>) { state.fatalError = action.payload; },
  },
});
export const runtimeActions = runtimeSlice.actions;
