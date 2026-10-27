import type { HoveredTool } from '../fab-scene';
import { createSliceStore } from './createSliceStore';

export interface RuntimeState {
  viewer: { epoch?: string; generation: number; status: string; hover?: HoveredTool; selectionSync?: string };
  fatalError?: string;
}

export const PREPARING_STATUS = '准备 WebGPU 视图…';
export const initialRuntimeState: RuntimeState = { viewer: { generation: 0, status: PREPARING_STATUS } };

const clearedViewer = (generation: number): RuntimeState['viewer'] => ({ generation, status: PREPARING_STATUS });

const runtime = createSliceStore(initialRuntimeState, {
  viewerMounted: (state, action) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation), epoch: action.payload } }),
  viewerStatusReceived: (state, action) => state.viewer.epoch !== action.payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, status: action.payload.status } },
  viewerHoverReceived: (state, action) => state.viewer.epoch !== action.payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, hover: action.payload.hover } },
  viewerHoverCleared: (state) => ({ ...state, viewer: { ...state.viewer, hover: undefined } }),
  viewerSelectionSyncStarted: (state, action) => ({ ...state, viewer: { ...state.viewer, selectionSync: action.payload } }),
  viewerSelectionSyncFinished: (state, action) => state.viewer.selectionSync !== action.payload
    ? state
    : { ...state, viewer: { ...state.viewer, selectionSync: undefined } },
  viewerReloadRequested: (state) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation + 1) } }),
  viewerUnmounted: (state, action) => state.viewer.epoch !== action.payload
    ? state
    : { ...state, viewer: { ...clearedViewer(state.viewer.generation) } },
  fatalErrorSet: (state, action) => ({ ...state, fatalError: action.payload }),
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
