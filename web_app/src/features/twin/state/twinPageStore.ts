import type { AmhsStats, PickedTool, SceneLayer } from '../../../application/ports/scene';
import { FAB_TOOL_STATES, type FabToolState } from '../../../domain/fab/fab-layout';
import type { EquipmentStatusScope } from '../../../realtime/equipment-status';
import type { TwinSelection } from '../../../domain/fab/original-twin-data';
import type { MesJob } from '../../../domain/fab/process-control';
import { DEFAULT_YIELD_INPUT, type YieldInput } from '../../../domain/fab/fab-yield';
import type { DefectPattern } from '../../../domain/wafer/wafer-map';
import type { WaferProduct } from '../../../domain/wafer/wafer-route';
import type { WaferHud } from '../../../domain/wafer/wafer-timeline';
import { createSliceStore } from '../../../state/createSliceStore';

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

const twinPage = createSliceStore(initialTwinPageState, {
  siteIdSet: (state, siteId?: string) => page(state, { siteId }),
  siteErrorSet: (state, siteError?: string) => page(state, { siteError }),
  /**
   * A01: in-place scope handover in one atomic update. Clears every FAB-scoped
   * projection so the next FAB never renders the previous FAB's snapshot, feed or
   * MES demo state before its own first accepted frame.
   */
  liveScopeActivated: (state, liveStatusScope: EquipmentStatusScope) => page(state, {
    liveStatusScope,
    liveToolStates: [...FAB_TOOL_STATES],
    statusFeed: undefined,
    mesJobs: {},
    inspectorMes: {},
  }),
  liveSnapshotReceived: (state, payload: { scope: EquipmentStatusScope; states: FabToolState[]; updatedAt: string }) => {
    // Scope token guard: a coalesced batch that raced the switch can never apply.
    if (!sameScope(state.liveStatusScope, payload.scope)) return state;
    return page(state, {
      liveToolStates: payload.states,
      statusFeed: { updatedAt: payload.updatedAt, stale: false },
    });
  },
  replayBaseSet: (state, replayBase: readonly FabToolState[]) => page(state, { replayBase: [...replayBase] }),
  statusFeedStale: (state, payload?: { scope?: EquipmentStatusScope }) => {
    const scope = payload?.scope;
    if (scope && !sameScope(state.liveStatusScope, scope)) return state;
    return state.statusFeed
      ? page(state, { statusFeed: { ...state.statusFeed, stale: true } })
      : state;
  },
  selectedSet: (state, selected?: PickedTool) => page(state, { selected }),
  selectionSet: (state, selection?: TwinSelection) => page(state, { selection }),
  mesJobSet: (state, payload: { index: number; job: MesJob }) => page(state, { mesJobs: { ...state.mesJobs, [payload.index]: payload.job } }),
  layerToggled: (state, layer: SceneLayer) => page(state, { layerPreferences: { ...state.layerPreferences, [layer]: !state.layerPreferences[layer] } }),
  amhsSet: (state, amhs?: AmhsStats) => page(state, { amhs }),
  infoDialogSet: (state, infoDialog: 'architecture' | 'database' | null) => page(state, { infoDialog }),
  showResearchUtilToggled: (state) => page(state, { showResearchUtil: !state.showResearchUtil }),
  onboardingDontShowSet: (state, onboardingDontShow: boolean) => page(state, { onboardingDontShow }),
  waferFrameReceived: (state, frame: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }) => wafer(state, frame),
  /**
   * Closing a wafer session drops the projected frame; the Twin UI store owns
   * close/playback and never mutates this store directly (see
   * features/twin/wafer-session.ts for the coordinated use case).
   */
  waferFrameCleared: (state) => wafer(state, { hud: undefined, completed: false }),
  waferFollowSet: (state, follow: boolean) => wafer(state, { follow }),
  ymsOpenSet: (state, open: boolean) => yms(state, { open }),
  ymsTabSet: (state, tab: 'map' | 'yield') => yms(state, { tab }),
  ymsRandomize: (state, pattern: DefectPattern) => yms(state, { pattern, seed: state.yms.seed + 1 }),
  ymsHoverDieSet: (state, hoverDie?: YmsUiState['hoverDie']) => yms(state, { hoverDie }),
  ymsDieAreaSet: (state, dieArea: number) => yms(state, { dieArea }),
  ymsDefectD0Set: (state, defectD0: number) => yms(state, { defectD0 }),
  ymsClusterAlphaSet: (state, clusterAlpha: number) => yms(state, { clusterAlpha }),
  ymsYieldInputSet: (state, yieldInput: YieldInput) => yms(state, { yieldInput }),
  ymsYieldScenarioSet: (state, yieldScenario: string) => yms(state, { yieldScenario }),
  ymsStdfCopiedSet: (state, stdfCopied: boolean) => yms(state, { stdfCopied }),
  sidebarTabSet: (state, tab: 'fab' | 'oem') => sidebar(state, { tab, query: '', segment: 'ALL', switched: true }),
  sidebarQuerySet: (state, query: string) => sidebar(state, { query }),
  sidebarCategorySet: (state, category: string) => sidebar(state, { category }),
  sidebarSegmentSet: (state, segment: string) => sidebar(state, { segment }),
  sidebarStateFilterToggle: (state, stateFilter: string) => sidebar(state, {
    stateFilter: state.sidebar.stateFilter === stateFilter ? 'ALL' : stateFilter,
  }),
  inspectorMesSet: (state, payload: { id: string; job: MesJob }) => page(state, { inspectorMes: { ...state.inspectorMes, [payload.id]: payload.job } }),
  oemDialogQuerySet: (state, query: string) => oemDialog(state, { query }),
  oemDialogSegmentSet: (state, segment: string) => oemDialog(state, { segment }),
  oemDialogVendorSet: (state, vendor: string) => oemDialog(state, { vendor }),
  archQuerySet: (state, query: string) => page(state, { archQuery: query }),
});

export const useTwinPageStore = twinPage.useStore;
export const twinPageActions = twinPage.actions;
export const resetTwinPageStore = twinPage.reset;
