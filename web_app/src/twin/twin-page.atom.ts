import type { AmhsStats, PickedTool, SceneLayer } from '@/contracts/scene.port';
import { FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import type { EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import type { TwinSelection } from '@/domain/original-twin-data';
import type { MesJob } from '@/domain/fab-process-control';
import { DEFAULT_YIELD_INPUT, type YieldInput } from '@/domain/fab-yield';
import type { DefectPattern } from '@/domain/wafer-map';
import type { WaferProduct } from '@/domain/wafer-route';
import type { WaferHud } from '@/domain/wafer-timeline';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

export type WaferUiState = {
  product: WaferProduct;
  index: number;
  follow: boolean;
  hud?: WaferHud;
  completed: boolean;
};
export type YmsUiState = {
  open: boolean;
  tab: 'map' | 'yield';
  pattern: DefectPattern;
  seed: number;
  hoverDie?: { r: number; c: number; bin: 1 | 2 | 3 | 4 | 5 };
  dieArea: number;
  defectD0: number;
  clusterAlpha: number;
  yieldInput: YieldInput;
  yieldScenario: string;
  stdfCopied: boolean;
};
export interface TwinPageState {
  siteId?: string;
  siteError?: string;
  /**
   * Composite (siteId, fabId) identity that owns the FAB-scoped server/MES
   * projections below. A scope activation clears the projections before a frame
   * from the new FAB can be rendered; siteId alone is not a scope change.
   */
  liveStatusScope?: EquipmentStatusScope;
  liveToolStates: FabToolState[];
  replayBase: FabToolState[];
  statusFeed?: { updatedAt: string; stale: boolean };
  selected?: PickedTool;
  selection?: TwinSelection;
  mesJobs: Record<number, MesJob>;
  layerPreferences: Record<SceneLayer, boolean>;
  amhs?: AmhsStats;
  infoDialog: 'architecture' | 'database' | null;
  showResearchUtil: boolean;
  onboardingDontShow: boolean;
  wafer: WaferUiState;
  yms: YmsUiState;
  sidebar: {
    tab: 'fab' | 'oem';
    query: string;
    category: string;
    segment: string;
    stateFilter: string;
    switched: boolean;
  };
  inspectorMes: Record<string, MesJob>;
  oemDialog: { query: string; segment: string; vendor: string };
  archQuery: string;
}

export const initialTwinPageState: TwinPageState = {
  liveStatusScope: undefined,
  liveToolStates: [...FAB_TOOL_STATES],
  replayBase: [...FAB_TOOL_STATES],
  mesJobs: {},
  layerPreferences: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false },
  infoDialog: null,
  showResearchUtil: true,
  onboardingDontShow: true,
  wafer: { product: 'A', index: 0, follow: true, completed: false },
  yms: { open: false, tab: 'map', pattern: 'clean', seed: 811, dieArea: 100, defectD0: 0.15, clusterAlpha: 3, yieldInput: DEFAULT_YIELD_INPUT, yieldScenario: 'live', stdfCopied: false },
  sidebar: { tab: 'fab', query: '', category: 'ALL', segment: 'ALL', stateFilter: 'ALL', switched: false },
  inspectorMes: {},
  oemDialog: { query: '', segment: 'ALL', vendor: 'ALL' },
  archQuery: '',
};

type Patch<T> = Partial<T>;
const page = (state: TwinPageState, patch: Patch<TwinPageState>): TwinPageState => ({ ...state, ...patch });
const wafer = (state: TwinPageState, patch: Patch<WaferUiState>): TwinPageState => page(state, { wafer: { ...state.wafer, ...patch } });
const yms = (state: TwinPageState, patch: Patch<YmsUiState>): TwinPageState => page(state, { yms: { ...state.yms, ...patch } });
const sidebar = (state: TwinPageState, patch: Patch<TwinPageState['sidebar']>): TwinPageState => page(state, { sidebar: { ...state.sidebar, ...patch } });
const oemDialog = (state: TwinPageState, patch: Patch<TwinPageState['oemDialog']>): TwinPageState => page(state, { oemDialog: { ...state.oemDialog, ...patch } });
const sameScope = (left: EquipmentStatusScope | undefined, right: EquipmentStatusScope): boolean =>
  left !== undefined && left.siteId === right.siteId && left.fabId === right.fabId;

const reducers = {
  siteIdSet: (state: TwinPageState, siteId?: string) => page(state, { siteId }),
  siteErrorSet: (state: TwinPageState, siteError?: string) => page(state, { siteError }),
  /**
   * A01: in-place scope handover in one atomic update. Clears every FAB-scoped
   * projection so the next FAB never renders the previous FAB's snapshot, feed or
   * MES demo state before its own first accepted frame.
   */
  liveScopeActivated: (state: TwinPageState, liveStatusScope: EquipmentStatusScope) => page(state, {
    liveStatusScope,
    liveToolStates: [...FAB_TOOL_STATES],
    statusFeed: undefined,
    mesJobs: {},
    inspectorMes: {},
  }),
  liveSnapshotReceived: (state: TwinPageState, payload: { scope: EquipmentStatusScope; states: FabToolState[]; updatedAt: string }) => {
    // Scope token guard: a coalesced batch that raced the switch can never apply.
    if (!sameScope(state.liveStatusScope, payload.scope)) return state;
    return page(state, {
      liveToolStates: payload.states,
      statusFeed: { updatedAt: payload.updatedAt, stale: false },
    });
  },
  replayBaseSet: (state: TwinPageState, replayBase: readonly FabToolState[]) => page(state, { replayBase: [...replayBase] }),
  statusFeedStale: (state: TwinPageState, payload?: { scope?: EquipmentStatusScope }) => {
    const scope = payload?.scope;
    if (scope && !sameScope(state.liveStatusScope, scope)) return state;
    return state.statusFeed
      ? page(state, { statusFeed: { ...state.statusFeed, stale: true } })
      : state;
  },
  selectedSet: (state: TwinPageState, selected?: PickedTool) => page(state, { selected }),
  selectionSet: (state: TwinPageState, selection?: TwinSelection) => page(state, { selection }),
  mesJobSet: (state: TwinPageState, payload: { index: number; job: MesJob }) => page(state, { mesJobs: { ...state.mesJobs, [payload.index]: payload.job } }),
  layerToggled: (state: TwinPageState, layer: SceneLayer) => page(state, { layerPreferences: { ...state.layerPreferences, [layer]: !state.layerPreferences[layer] } }),
  amhsSet: (state: TwinPageState, amhs?: AmhsStats) => page(state, { amhs }),
  infoDialogSet: (state: TwinPageState, infoDialog: 'architecture' | 'database' | null) => page(state, { infoDialog }),
  showResearchUtilToggled: (state: TwinPageState) => page(state, { showResearchUtil: !state.showResearchUtil }),
  onboardingDontShowSet: (state: TwinPageState, onboardingDontShow: boolean) => page(state, { onboardingDontShow }),
  waferFrameReceived: (state: TwinPageState, frame: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }) => wafer(state, frame),
  /**
   * Closing a wafer session drops the projected frame; the Twin UI store owns
   * close/playback and never mutates this store directly (see
   * features/twin/wafer-session.ts for the coordinated use case).
   */
  waferFrameCleared: (state: TwinPageState) => wafer(state, { hud: undefined, completed: false }),
  waferFollowSet: (state: TwinPageState, follow: boolean) => wafer(state, { follow }),
  ymsOpenSet: (state: TwinPageState, open: boolean) => yms(state, { open }),
  ymsTabSet: (state: TwinPageState, tab: 'map' | 'yield') => yms(state, { tab }),
  ymsRandomize: (state: TwinPageState, pattern: DefectPattern) => yms(state, { pattern, seed: state.yms.seed + 1 }),
  ymsHoverDieSet: (state: TwinPageState, hoverDie?: YmsUiState['hoverDie']) => yms(state, { hoverDie }),
  ymsDieAreaSet: (state: TwinPageState, dieArea: number) => yms(state, { dieArea }),
  ymsDefectD0Set: (state: TwinPageState, defectD0: number) => yms(state, { defectD0 }),
  ymsClusterAlphaSet: (state: TwinPageState, clusterAlpha: number) => yms(state, { clusterAlpha }),
  ymsYieldInputSet: (state: TwinPageState, yieldInput: YieldInput) => yms(state, { yieldInput }),
  ymsYieldScenarioSet: (state: TwinPageState, yieldScenario: string) => yms(state, { yieldScenario }),
  ymsStdfCopiedSet: (state: TwinPageState, stdfCopied: boolean) => yms(state, { stdfCopied }),
  sidebarTabSet: (state: TwinPageState, tab: 'fab' | 'oem') => sidebar(state, { tab, query: '', segment: 'ALL', switched: true }),
  sidebarQuerySet: (state: TwinPageState, query: string) => sidebar(state, { query }),
  sidebarCategorySet: (state: TwinPageState, category: string) => sidebar(state, { category }),
  sidebarSegmentSet: (state: TwinPageState, segment: string) => sidebar(state, { segment }),
  sidebarStateFilterToggle: (state: TwinPageState, stateFilter: string) => sidebar(state, {
    stateFilter: state.sidebar.stateFilter === stateFilter ? 'ALL' : stateFilter,
  }),
  inspectorMesSet: (state: TwinPageState, payload: { id: string; job: MesJob }) => page(state, { inspectorMes: { ...state.inspectorMes, [payload.id]: payload.job } }),
  oemDialogQuerySet: (state: TwinPageState, query: string) => oemDialog(state, { query }),
  oemDialogSegmentSet: (state: TwinPageState, segment: string) => oemDialog(state, { segment }),
  oemDialogVendorSet: (state: TwinPageState, vendor: string) => oemDialog(state, { vendor }),
  archQuerySet: (state: TwinPageState, query: string) => page(state, { archQuery: query }),
};

export const twinPageAtom = Atom.make<TwinPageState>(initialTwinPageState).pipe(Atom.keepAlive);

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
  selectedSet: (registry: AtomRegistry.AtomRegistry, selected?: PickedTool): void => {
    registry.update(twinPageAtom, state => reducers.selectedSet(state, selected));
  },
  selectionSet: (registry: AtomRegistry.AtomRegistry, selection?: TwinSelection): void => {
    registry.update(twinPageAtom, state => reducers.selectionSet(state, selection));
  },
  mesJobSet: (registry: AtomRegistry.AtomRegistry, payload: { index: number; job: MesJob }): void => {
    registry.update(twinPageAtom, state => reducers.mesJobSet(state, payload));
  },
  layerToggled: (registry: AtomRegistry.AtomRegistry, layer: SceneLayer): void => {
    registry.update(twinPageAtom, state => reducers.layerToggled(state, layer));
  },
  amhsSet: (registry: AtomRegistry.AtomRegistry, amhs?: AmhsStats): void => {
    registry.update(twinPageAtom, state => reducers.amhsSet(state, amhs));
  },
  infoDialogSet: (registry: AtomRegistry.AtomRegistry, infoDialog: 'architecture' | 'database' | null): void => {
    registry.update(twinPageAtom, state => reducers.infoDialogSet(state, infoDialog));
  },
  showResearchUtilToggled: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(twinPageAtom, state => reducers.showResearchUtilToggled(state));
  },
  onboardingDontShowSet: (registry: AtomRegistry.AtomRegistry, onboardingDontShow: boolean): void => {
    registry.update(twinPageAtom, state => reducers.onboardingDontShowSet(state, onboardingDontShow));
  },
  waferFrameReceived: (registry: AtomRegistry.AtomRegistry, frame: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }): void => {
    registry.update(twinPageAtom, state => reducers.waferFrameReceived(state, frame));
  },
  waferFrameCleared: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(twinPageAtom, state => reducers.waferFrameCleared(state));
  },
  waferFollowSet: (registry: AtomRegistry.AtomRegistry, follow: boolean): void => {
    registry.update(twinPageAtom, state => reducers.waferFollowSet(state, follow));
  },
  ymsOpenSet: (registry: AtomRegistry.AtomRegistry, open: boolean): void => {
    registry.update(twinPageAtom, state => reducers.ymsOpenSet(state, open));
  },
  ymsTabSet: (registry: AtomRegistry.AtomRegistry, tab: 'map' | 'yield'): void => {
    registry.update(twinPageAtom, state => reducers.ymsTabSet(state, tab));
  },
  ymsRandomize: (registry: AtomRegistry.AtomRegistry, pattern: DefectPattern): void => {
    registry.update(twinPageAtom, state => reducers.ymsRandomize(state, pattern));
  },
  ymsHoverDieSet: (registry: AtomRegistry.AtomRegistry, hoverDie?: YmsUiState['hoverDie']): void => {
    registry.update(twinPageAtom, state => reducers.ymsHoverDieSet(state, hoverDie));
  },
  ymsDieAreaSet: (registry: AtomRegistry.AtomRegistry, dieArea: number): void => {
    registry.update(twinPageAtom, state => reducers.ymsDieAreaSet(state, dieArea));
  },
  ymsDefectD0Set: (registry: AtomRegistry.AtomRegistry, defectD0: number): void => {
    registry.update(twinPageAtom, state => reducers.ymsDefectD0Set(state, defectD0));
  },
  ymsClusterAlphaSet: (registry: AtomRegistry.AtomRegistry, clusterAlpha: number): void => {
    registry.update(twinPageAtom, state => reducers.ymsClusterAlphaSet(state, clusterAlpha));
  },
  ymsYieldInputSet: (registry: AtomRegistry.AtomRegistry, yieldInput: YieldInput): void => {
    registry.update(twinPageAtom, state => reducers.ymsYieldInputSet(state, yieldInput));
  },
  ymsYieldScenarioSet: (registry: AtomRegistry.AtomRegistry, yieldScenario: string): void => {
    registry.update(twinPageAtom, state => reducers.ymsYieldScenarioSet(state, yieldScenario));
  },
  ymsStdfCopiedSet: (registry: AtomRegistry.AtomRegistry, stdfCopied: boolean): void => {
    registry.update(twinPageAtom, state => reducers.ymsStdfCopiedSet(state, stdfCopied));
  },
  sidebarTabSet: (registry: AtomRegistry.AtomRegistry, tab: 'fab' | 'oem'): void => {
    registry.update(twinPageAtom, state => reducers.sidebarTabSet(state, tab));
  },
  sidebarQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageAtom, state => reducers.sidebarQuerySet(state, query));
  },
  sidebarCategorySet: (registry: AtomRegistry.AtomRegistry, category: string): void => {
    registry.update(twinPageAtom, state => reducers.sidebarCategorySet(state, category));
  },
  sidebarSegmentSet: (registry: AtomRegistry.AtomRegistry, segment: string): void => {
    registry.update(twinPageAtom, state => reducers.sidebarSegmentSet(state, segment));
  },
  sidebarStateFilterToggle: (registry: AtomRegistry.AtomRegistry, stateFilter: string): void => {
    registry.update(twinPageAtom, state => reducers.sidebarStateFilterToggle(state, stateFilter));
  },
  inspectorMesSet: (registry: AtomRegistry.AtomRegistry, payload: { id: string; job: MesJob }): void => {
    registry.update(twinPageAtom, state => reducers.inspectorMesSet(state, payload));
  },
  oemDialogQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageAtom, state => reducers.oemDialogQuerySet(state, query));
  },
  oemDialogSegmentSet: (registry: AtomRegistry.AtomRegistry, segment: string): void => {
    registry.update(twinPageAtom, state => reducers.oemDialogSegmentSet(state, segment));
  },
  oemDialogVendorSet: (registry: AtomRegistry.AtomRegistry, vendor: string): void => {
    registry.update(twinPageAtom, state => reducers.oemDialogVendorSet(state, vendor));
  },
  archQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageAtom, state => reducers.archQuerySet(state, query));
  },
};
