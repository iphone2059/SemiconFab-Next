import { FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import type { MesJob } from '@/domain/fab-process-control';
import type { EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * FAB-scoped server/session projections for the Twin page.
 *
 * Owner: the EquipmentStatusPipeline / route-state controllers for one
 * (siteId, fabId) lifetime. FAB handover clears these projections atomically via
 * `liveScopeActivated` before a new FAB can paint. This atom is the only place a
 * late frame from the previous FAB could leak into. UI overlays, wafer playback frames, YMS
 * inputs and AMHS scene statistics live in their own atoms (they have different
 * owners and update frequencies) — see twin-page-ui.atom.ts, twin-wafer.atom.ts,
 * twin-yms.atom.ts, twin-amhs.atom.ts.
 */
export interface TwinFabState {
  siteId?: string;
  siteError?: string;
  /**
   * Composite (siteId, fabId) identity that owns the FAB-scoped server/MES
   * projections below. A scope activation clears the projections before a frame
   * from the new FAB can be rendered; siteId alone is not a scope change.
   */
  liveStatusScope?: EquipmentStatusScope;
  liveToolStates: FabToolState[];
  /** Fixed research baseline owned by liveStatusScope, not by the latest live frame. */
  replayBase: FabToolState[];
  statusFeed?: { updatedAt: string; stale: boolean };
  mesJobs: Record<number, MesJob>;
  inspectorMes: Record<string, MesJob>;
}

export const initialTwinFabState: TwinFabState = {
  liveStatusScope: undefined,
  liveToolStates: [...FAB_TOOL_STATES],
  replayBase: [...FAB_TOOL_STATES],
  mesJobs: {},
  inspectorMes: {},
};

const page = (state: TwinFabState, patch: Partial<TwinFabState>): TwinFabState => ({ ...state, ...patch });
const sameScope = (left: EquipmentStatusScope | undefined, right: EquipmentStatusScope): boolean =>
  left !== undefined && left.siteId === right.siteId && left.fabId === right.fabId;

const reducers = {
  siteIdSet: (state: TwinFabState, siteId?: string) => page(state, { siteId }),
  siteErrorSet: (state: TwinFabState, siteError?: string) => page(state, { siteError }),
  /**
   * A01: in-place scope handover in one atomic update. Clears every FAB-scoped
   * projection so the next FAB never renders the previous FAB's snapshot, feed or
   * MES demo state before its own first accepted frame. Replay uses the default
   * FAB_TOOL_STATES on a composite scope change (including research deep links),
   * never a previous FAB's captured baseline. Same-scope keepAlive remounts retain
   * their fixed baseline; only explicit research entry captures current states.
   * Live frames must not rebase playback, including equipment absent from replay.
   */
  liveScopeActivated: (state: TwinFabState, liveStatusScope: EquipmentStatusScope) => page(state, {
    liveStatusScope,
    liveToolStates: [...FAB_TOOL_STATES],
    replayBase: sameScope(state.liveStatusScope, liveStatusScope) ? state.replayBase : [...FAB_TOOL_STATES],
    statusFeed: undefined,
    mesJobs: {},
    inspectorMes: {},
  }),
  liveSnapshotReceived: (state: TwinFabState, payload: { scope: EquipmentStatusScope; states: FabToolState[]; updatedAt: string }) => {
    // Scope token guard: a coalesced batch that raced the switch can never apply.
    if (!sameScope(state.liveStatusScope, payload.scope)) return state;
    return page(state, {
      liveToolStates: payload.states,
      statusFeed: { updatedAt: payload.updatedAt, stale: false },
    });
  },
  replayBaseSet: (state: TwinFabState, replayBase: readonly FabToolState[]) => page(state, { replayBase: [...replayBase] }),
  statusFeedStale: (state: TwinFabState, payload?: { scope?: EquipmentStatusScope }) => {
    const scope = payload?.scope;
    if (scope && !sameScope(state.liveStatusScope, scope)) return state;
    return state.statusFeed
      ? page(state, { statusFeed: { ...state.statusFeed, stale: true } })
      : state;
  },
  mesJobSet: (state: TwinFabState, payload: { index: number; job: MesJob }) => page(state, { mesJobs: { ...state.mesJobs, [payload.index]: payload.job } }),
  inspectorMesSet: (state: TwinFabState, payload: { id: string; job: MesJob }) => page(state, { inspectorMes: { ...state.inspectorMes, [payload.id]: payload.job } }),
};

export const twinPageAtom = Atom.make<TwinFabState>(initialTwinFabState).pipe(Atom.keepAlive);

export const twinPageActions = {
  siteIdSet: (registry: AtomRegistry.AtomRegistry, siteId?: string): void => {
    registry.update(twinPageAtom, state => reducers.siteIdSet(state, siteId));
  },
  siteErrorSet: (registry: AtomRegistry.AtomRegistry, siteError?: string): void => {
    registry.update(twinPageAtom, state => reducers.siteErrorSet(state, siteError));
  },
  liveScopeActivated: (registry: AtomRegistry.AtomRegistry, liveStatusScope: EquipmentStatusScope): void => {
    registry.update(twinPageAtom, state => reducers.liveScopeActivated(state, liveStatusScope));
  },
  liveSnapshotReceived: (registry: AtomRegistry.AtomRegistry, payload: { scope: EquipmentStatusScope; states: FabToolState[]; updatedAt: string }): void => {
    registry.update(twinPageAtom, state => reducers.liveSnapshotReceived(state, payload));
  },
  replayBaseSet: (registry: AtomRegistry.AtomRegistry, replayBase: readonly FabToolState[]): void => {
    registry.update(twinPageAtom, state => reducers.replayBaseSet(state, replayBase));
  },
  statusFeedStale: (registry: AtomRegistry.AtomRegistry, payload?: { scope?: EquipmentStatusScope }): void => {
    registry.update(twinPageAtom, state => reducers.statusFeedStale(state, payload));
  },
  mesJobSet: (registry: AtomRegistry.AtomRegistry, payload: { index: number; job: MesJob }): void => {
    registry.update(twinPageAtom, state => reducers.mesJobSet(state, payload));
  },
  inspectorMesSet: (registry: AtomRegistry.AtomRegistry, payload: { id: string; job: MesJob }): void => {
    registry.update(twinPageAtom, state => reducers.inspectorMesSet(state, payload));
  },
};
