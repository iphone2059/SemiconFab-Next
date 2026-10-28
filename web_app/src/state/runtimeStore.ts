import type { HoveredTool, SceneLifecycleEvent } from '../application/ports/scene';
import { createSliceStore } from './createSliceStore';

/**
 * Discrete viewer lifecycle owned by the runtime store (R-04). Scene-sync effects and the
 * readiness UI switch on this state only; the `status` string is display copy and must never
 * be parsed to decide product behavior (the previous status.startsWith('WebGPU') contract).
 */
export type ViewerLifecycle = 'idle' | 'initializing' | 'ready' | 'recovering' | 'failed' | 'disposed';

export interface RuntimeState {
  viewer: {
    epoch?: string;
    generation: number;
    lifecycle: ViewerLifecycle;
    /** Display copy for HUD/status lines. Never used for control decisions. */
    status: string;
    hover?: HoveredTool;
    selectionSync?: string;
  };
  fatalError?: string;
}

export const PREPARING_STATUS = '准备 WebGPU 视图…';
export const initialRuntimeState: RuntimeState = {
  viewer: { generation: 0, lifecycle: 'idle', status: PREPARING_STATUS },
};

const clearedViewer = (generation: number, lifecycle: ViewerLifecycle = 'idle'): RuntimeState['viewer'] =>
  ({ generation, lifecycle, status: PREPARING_STATUS });

const runtime = createSliceStore(initialRuntimeState, {
  viewerMounted: (state, epoch: string) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation, 'initializing'), epoch } }),
  viewerLifecycleReceived: (state, payload: { epoch: string; event: SceneLifecycleEvent }) => state.viewer.epoch !== payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, lifecycle: payload.event.type, status: payload.event.message } },
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
    : { ...state, viewer: { ...clearedViewer(state.viewer.generation, 'disposed') } },
  fatalErrorSet: (state, fatalError: string) => ({ ...state, fatalError }),
});

export const useRuntimeStore = runtime.useStore;
export const runtimeActions = runtime.actions;
export const resetRuntimeStore = runtime.reset;
