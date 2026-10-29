import type { HoveredTool, SceneLifecycleEvent } from '@/contracts/scene.port';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * Rendering-scope viewer lifecycle (R-04), split out of the former runtime store.
 *
 * Three atoms by update frequency / owner instead of one keepAlive object:
 *
 * - `viewerSessionAtom`: mount/reload identity + discrete lifecycle. Scene-sync
 *   effects and the readiness UI switch on the lifecycle enum only; the
 *   `status` string is display copy and must never be parsed to decide product
 *   behavior (the previous status.startsWith('WebGPU') contract).
 * - `viewerHoverAtom`: hover-card payload updated on a 50 ms coalesced path.
 *   Splitting it keeps hover moves from notifying readiness/lifecycle subscribers.
 * - `viewerSelectionSyncAtom`: transient scene<->selection handshake token.
 */
export type ViewerLifecycle = 'idle' | 'initializing' | 'ready' | 'recovering' | 'failed' | 'disposed';

export interface ViewerSession {
  /** Opaque identity of the mounted scene; callbacks from a replaced scene carry an older epoch. */
  epoch?: string;
  /** Bumped by an explicit reload request; the scene mount effect depends on it. */
  generation: number;
  lifecycle: ViewerLifecycle;
  /** Display copy for HUD/status lines. Never used for control decisions. */
  status: string;
}

export const PREPARING_STATUS = '准备 WebGPU 视图…';

export const initialViewerSession: ViewerSession = {
  generation: 0,
  lifecycle: 'idle',
  status: PREPARING_STATUS,
};

export const viewerSessionAtom = Atom.make<ViewerSession>(initialViewerSession).pipe(Atom.keepAlive);
export const viewerHoverAtom = Atom.make<HoveredTool | undefined>(undefined).pipe(Atom.keepAlive);
export const viewerSelectionSyncAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

const clearedSession = (generation: number, lifecycle: ViewerLifecycle = 'idle'): ViewerSession =>
  ({ generation, lifecycle, status: PREPARING_STATUS });

/** A replaced viewer owns no hover/selection-sync residue. */
const clearTransientProjections = (registry: AtomRegistry.AtomRegistry): void => {
  registry.set(viewerHoverAtom, undefined);
  registry.set(viewerSelectionSyncAtom, undefined);
};

export const viewerActions = {
  viewerMounted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    Atom.batch(() => {
      registry.set(viewerSessionAtom, { ...clearedSession(registry.get(viewerSessionAtom).generation, 'initializing'), epoch });
      clearTransientProjections(registry);
    });
  },
  viewerLifecycleReceived: (registry: AtomRegistry.AtomRegistry, payload: { epoch: string; event: SceneLifecycleEvent }): void => {
    const current = registry.get(viewerSessionAtom);
    if (current.epoch !== payload.epoch) return;
    registry.set(viewerSessionAtom, { ...current, lifecycle: payload.event.type, status: payload.event.message });
  },
  viewerHoverReceived: (registry: AtomRegistry.AtomRegistry, payload: { epoch: string; hover?: HoveredTool }): void => {
    if (registry.get(viewerSessionAtom).epoch !== payload.epoch) return;
    registry.set(viewerHoverAtom, payload.hover);
  },
  viewerHoverCleared: (registry: AtomRegistry.AtomRegistry): void => {
    registry.set(viewerHoverAtom, undefined);
  },
  viewerSelectionSyncStarted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    registry.set(viewerSelectionSyncAtom, epoch);
  },
  viewerSelectionSyncFinished: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    if (registry.get(viewerSelectionSyncAtom) !== epoch) return;
    registry.set(viewerSelectionSyncAtom, undefined);
  },
  viewerReloadRequested: (registry: AtomRegistry.AtomRegistry): void => {
    Atom.batch(() => {
      registry.set(viewerSessionAtom, clearedSession(registry.get(viewerSessionAtom).generation + 1));
      clearTransientProjections(registry);
    });
  },
  viewerUnmounted: (registry: AtomRegistry.AtomRegistry, epoch: string): void => {
    const current = registry.get(viewerSessionAtom);
    if (current.epoch !== epoch) return;
    Atom.batch(() => {
      registry.set(viewerSessionAtom, clearedSession(current.generation, 'disposed'));
      clearTransientProjections(registry);
    });
  },
};
