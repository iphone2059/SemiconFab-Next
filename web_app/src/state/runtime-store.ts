import type { HoveredTool, SceneLifecycleEvent } from '@/contracts/scene.port';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

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

const reducers = {
  viewerMounted: (state: RuntimeState, epoch: string) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation, 'initializing'), epoch } }),
  viewerLifecycleReceived: (state: RuntimeState, payload: { epoch: string; event: SceneLifecycleEvent }) => state.viewer.epoch !== payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, lifecycle: payload.event.type, status: payload.event.message } },
  viewerHoverReceived: (state: RuntimeState, payload: { epoch: string; hover?: HoveredTool }) => state.viewer.epoch !== payload.epoch
    ? state
    : { ...state, viewer: { ...state.viewer, hover: payload.hover } },
  viewerHoverCleared: (state: RuntimeState) => ({ ...state, viewer: { ...state.viewer, hover: undefined } }),
  viewerSelectionSyncStarted: (state: RuntimeState, epoch: string) => ({ ...state, viewer: { ...state.viewer, selectionSync: epoch } }),
  viewerSelectionSyncFinished: (state: RuntimeState, epoch: string) => state.viewer.selectionSync !== epoch
    ? state
    : { ...state, viewer: { ...state.viewer, selectionSync: undefined } },
  viewerReloadRequested: (state: RuntimeState) => ({ ...state, viewer: { ...clearedViewer(state.viewer.generation + 1) } }),
  viewerUnmounted: (state: RuntimeState, epoch: string) => state.viewer.epoch !== epoch
    ? state
    : { ...state, viewer: { ...clearedViewer(state.viewer.generation, 'disposed') } },
  fatalErrorSet: (state: RuntimeState, fatalError: string) => ({ ...state, fatalError }),
};

export const runtimeAtom = Atom.make<RuntimeState>(initialRuntimeState).pipe(Atom.keepAlive);

export const runtimeActions = {
  viewerMounted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    registry.update(runtimeAtom, state => reducers.viewerMounted(state, epoch));
  },
  viewerLifecycleReceived: (registry: AtomRegistry.AtomRegistry, payload: { epoch: string; event: SceneLifecycleEvent }): void => {
    registry.update(runtimeAtom, state => reducers.viewerLifecycleReceived(state, payload));
  },
  viewerHoverReceived: (registry: AtomRegistry.AtomRegistry, payload: { epoch: string; hover?: HoveredTool }): void => {
    registry.update(runtimeAtom, state => reducers.viewerHoverReceived(state, payload));
  },
  viewerHoverCleared: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(runtimeAtom, state => reducers.viewerHoverCleared(state));
  },
  viewerSelectionSyncStarted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    registry.update(runtimeAtom, state => reducers.viewerSelectionSyncStarted(state, epoch));
  },
  viewerSelectionSyncFinished: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    registry.update(runtimeAtom, state => reducers.viewerSelectionSyncFinished(state, epoch));
  },
  viewerReloadRequested: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(runtimeAtom, state => reducers.viewerReloadRequested(state));
  },
  viewerUnmounted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    registry.update(runtimeAtom, state => reducers.viewerUnmounted(state, epoch));
  },
  fatalErrorSet: (registry: AtomRegistry.AtomRegistry, fatalError: string): void => {
    registry.update(runtimeAtom, state => reducers.fatalErrorSet(state, fatalError));
  },
};
