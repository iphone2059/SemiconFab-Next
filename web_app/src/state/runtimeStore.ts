import type { HoveredTool } from '../fab-scene';
import { createImmerStore } from './createImmerStore';

export interface RuntimeState {
  viewer: { epoch?: string; generation: number; status: string; hover?: HoveredTool; selectionSync?: string };
  fatalError?: string;
}

export const PREPARING_STATUS = '准备 WebGPU 视图…';
export const initialRuntimeState: RuntimeState = { viewer: { generation: 0, status: PREPARING_STATUS } };

const runtime = createImmerStore(initialRuntimeState, {
  viewerMounted(state, action) {
    state.viewer.epoch = action.payload;
    state.viewer.status = PREPARING_STATUS;
    state.viewer.hover = undefined;
    state.viewer.selectionSync = undefined;
  },
  viewerStatusReceived(state, action) {
    if (state.viewer.epoch === action.payload.epoch) state.viewer.status = action.payload.status;
  },
  viewerHoverReceived(state, action) {
    if (state.viewer.epoch === action.payload.epoch) state.viewer.hover = action.payload.hover;
  },
  viewerHoverCleared(state) { state.viewer.hover = undefined; },
  viewerSelectionSyncStarted(state, action) { state.viewer.selectionSync = action.payload; },
  viewerSelectionSyncFinished(state, action) {
    if (state.viewer.selectionSync === action.payload) state.viewer.selectionSync = undefined;
  },
  viewerReloadRequested(state) {
    state.viewer.generation++;
    state.viewer.epoch = undefined;
    state.viewer.status = PREPARING_STATUS;
    state.viewer.hover = undefined;
    state.viewer.selectionSync = undefined;
  },
  viewerUnmounted(state, action) {
    if (state.viewer.epoch !== action.payload) return;
    state.viewer.epoch = undefined;
    state.viewer.status = PREPARING_STATUS;
    state.viewer.hover = undefined;
    state.viewer.selectionSync = undefined;
  },
  fatalErrorSet(state, action) { state.fatalError = action.payload; },
});

export const useRuntimeStore = runtime.useStore;
export const runtimeActions = runtime.actions as {
  viewerMounted: (epoch: string) => void;
  viewerStatusReceived: (payload: { epoch: string; status: string }) => void;
  viewerHoverReceived: (payload: { epoch: string; hover?: HoveredTool }) => void;
  viewerHoverCleared: () => void;
  viewerSelectionSyncStarted: (epoch: string) => void;
  viewerSelectionSyncFinished: (epoch: string) => void;
  viewerReloadRequested: () => void;
  viewerUnmounted: (epoch: string) => void;
  fatalErrorSet: (error: string) => void;
};
export const resetRuntimeStore = runtime.reset;
