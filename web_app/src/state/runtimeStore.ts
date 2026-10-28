import type { HoveredTool } from '../rendering/fab-scene';
import { createSliceStore } from './createSliceStore';

export interface RuntimeState {
  viewer: { epoch?: string; generation: number; status: string; hover?: HoveredTool; selectionSync?: string };
  fatalError?: string;
}

export const PREPARING_STATUS = '准备 WebGPU 视图…';
export const initialRuntimeState: RuntimeState = { viewer: { generation: 0, status: PREPARING_STATUS } };

const clearedViewer = (generation: number): RuntimeState['viewer'] => ({ generation, status: PREPARING_STATUS });

const runtime = createSliceStore(initialRuntimeState, {
  viewerMounted: (state, epoch: string) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation), epoch } }),
  viewerStatusReceived: (state, payload: { epoch: string; status: string }) => state.viewer.epoch !== payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, status: payload.status } },
  viewerHoverReceived: (state, payload: { epoch: string; hover?: HoveredTool }) => state.viewer.epoch !== payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, hover: payload.hover } },
  viewerHoverCleared: (state) => ({ ...state, viewer: { ...state.viewer, hover: undefined } }),
  viewerSelectionSyncStarted: (state, epoch: string) => ({ ...state, viewer: { ...state.viewer, selectionSync: epoch } }),
  viewerSelectionSyncFinished: (state, epoch: string) => state.viewer.selectionSync !== epoch
    ? state
    : { ...state, viewer: { ...state.viewer, selectionSync: undefined } },
  viewerReloadRequested: (state) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation + 1) } }),
  viewerUnmounted: (state, epoch: string) => state.viewer.epoch !== epoch
    ? state
    : { ...state, viewer: { ...clearedViewer(state.viewer.generation) } },
  fatalErrorSet: (state, fatalError: string) => ({ ...state, fatalError }),
});

export const useRuntimeStore = runtime.useStore;
export const runtimeActions = runtime.actions;
export const resetRuntimeStore = runtime.reset;
