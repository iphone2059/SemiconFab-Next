import type { AmhsStats, PickedTool, SceneLayer } from '../fab-scene';
import { FAB_TOOL_STATES, type FabToolState } from '../fab-layout';
import type { TwinSelection } from '../original-twin-data';
import type { MesJob } from '../process-control';
import { DEFAULT_YIELD_INPUT, type YieldInput } from '../fab-yield';
import type { DefectPattern } from '../wafer-map';
import type { WaferProduct } from '../wafer-route';
import type { WaferHud } from '../tour-wafer-timeline';
import { createImmerStore } from './createImmerStore';

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
  tourRemainingMs: number;
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
  liveToolStates: [...FAB_TOOL_STATES],
  replayBase: [...FAB_TOOL_STATES],
  mesJobs: {},
  layerPreferences: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false },
  infoDialog: null,
  showResearchUtil: true,
  tourRemainingMs: 0,
  onboardingDontShow: true,
  wafer: { product: 'A', index: 0, follow: true, completed: false },
  yms: { open: false, tab: 'map', pattern: 'clean', seed: 811, dieArea: 100, defectD0: 0.15, clusterAlpha: 3, yieldInput: DEFAULT_YIELD_INPUT, yieldScenario: 'live', stdfCopied: false },
  sidebar: { tab: 'fab', query: '', category: 'ALL', segment: 'ALL', stateFilter: 'ALL', switched: false },
  inspectorMes: {},
  oemDialog: { query: '', segment: 'ALL', vendor: 'ALL' },
  archQuery: '',
};

const page = createImmerStore(initialTwinPageState, {
  siteIdSet(state, action) { state.siteId = action.payload; },
  siteErrorSet(state, action) { state.siteError = action.payload; },
  liveSnapshotReceived(state, action) {
    state.liveToolStates = action.payload.states;
    state.statusFeed = { updatedAt: action.payload.updatedAt, stale: false };
  },
  replayBaseSet(state, action) { state.replayBase = [...action.payload]; },
  statusFeedStale(state) { if (state.statusFeed) state.statusFeed = { ...state.statusFeed, stale: true }; },
  selectedSet(state, action) { state.selected = action.payload; },
  selectionSet(state, action) { state.selection = action.payload; },
  mesJobSet(state, action) { state.mesJobs[action.payload.index] = action.payload.job; },
  layerToggled(state, action) { const layer = action.payload as SceneLayer; state.layerPreferences[layer] = !state.layerPreferences[layer]; },
  amhsSet(state, action) { state.amhs = action.payload; },
  infoDialogSet(state, action) { state.infoDialog = action.payload; },
  showResearchUtilToggled(state) { state.showResearchUtil = !state.showResearchUtil; },
  tourRemainingSet(state, action) { state.tourRemainingMs = Math.max(0, action.payload); },
  tourTick(state) { state.tourRemainingMs = Math.max(0, state.tourRemainingMs - 250); },
  onboardingDontShowSet(state, action) { state.onboardingDontShow = action.payload; },
  waferFrameReceived(state, action) {
    Object.assign(state.wafer, action.payload);
  },
  waferFollowSet(state, action) { state.wafer.follow = action.payload; },
  ymsOpenSet(state, action) { state.yms.open = action.payload; },
  ymsTabSet(state, action) { state.yms.tab = action.payload; },
  ymsRandomize(state, action) { state.yms.pattern = action.payload; state.yms.seed += 1; },
  ymsHoverDieSet(state, action) { state.yms.hoverDie = action.payload; },
  ymsDieAreaSet(state, action) { state.yms.dieArea = action.payload; },
  ymsDefectD0Set(state, action) { state.yms.defectD0 = action.payload; },
  ymsClusterAlphaSet(state, action) { state.yms.clusterAlpha = action.payload; },
  ymsYieldInputSet(state, action) { state.yms.yieldInput = action.payload; },
  ymsYieldScenarioSet(state, action) { state.yms.yieldScenario = action.payload; },
  ymsStdfCopiedSet(state, action) { state.yms.stdfCopied = action.payload; },
  sidebarTabSet(state, action) {
    state.sidebar.tab = action.payload;
    state.sidebar.query = '';
    state.sidebar.segment = 'ALL';
    state.sidebar.switched = true;
  },
  sidebarQuerySet(state, action) { state.sidebar.query = action.payload; },
  sidebarCategorySet(state, action) { state.sidebar.category = action.payload; },
  sidebarSegmentSet(state, action) { state.sidebar.segment = action.payload; },
  sidebarStateFilterToggle(state, action) {
    state.sidebar.stateFilter = state.sidebar.stateFilter === action.payload ? 'ALL' : action.payload;
  },
  inspectorMesSet(state, action) { state.inspectorMes[action.payload.id] = action.payload.job; },
  oemDialogQuerySet(state, action) { state.oemDialog.query = action.payload; },
  oemDialogSegmentSet(state, action) { state.oemDialog.segment = action.payload; },
  oemDialogVendorSet(state, action) { state.oemDialog.vendor = action.payload; },
  archQuerySet(state, action) { state.archQuery = action.payload; },
});

export const useTwinPageStore = page.useStore;
export const twinPageActions = page.actions as {
  siteIdSet: (siteId?: string) => void;
  siteErrorSet: (error?: string) => void;
  liveSnapshotReceived: (payload: { states: FabToolState[]; updatedAt: string }) => void;
  replayBaseSet: (states: readonly FabToolState[]) => void;
  statusFeedStale: () => void;
  selectedSet: (selected?: PickedTool) => void;
  selectionSet: (selection?: TwinSelection) => void;
  mesJobSet: (payload: { index: number; job: MesJob }) => void;
  layerToggled: (layer: SceneLayer) => void;
  amhsSet: (stats?: AmhsStats) => void;
  infoDialogSet: (dialog: 'architecture' | 'database' | null) => void;
  showResearchUtilToggled: () => void;
  tourRemainingSet: (ms: number) => void;
  tourTick: () => void;
  onboardingDontShowSet: (value: boolean) => void;
  waferFrameReceived: (payload: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }) => void;
  waferFollowSet: (follow: boolean) => void;
  ymsOpenSet: (open: boolean) => void;
  ymsTabSet: (tab: 'map' | 'yield') => void;
  ymsRandomize: (pattern: DefectPattern) => void;
  ymsHoverDieSet: (hover?: YmsUiState['hoverDie']) => void;
  ymsDieAreaSet: (area: number) => void;
  ymsDefectD0Set: (d0: number) => void;
  ymsClusterAlphaSet: (alpha: number) => void;
  ymsYieldInputSet: (input: YieldInput) => void;
  ymsYieldScenarioSet: (scenario: string) => void;
  ymsStdfCopiedSet: (copied: boolean) => void;
  sidebarTabSet: (tab: 'fab' | 'oem') => void;
  sidebarQuerySet: (query: string) => void;
  sidebarCategorySet: (category: string) => void;
  sidebarSegmentSet: (segment: string) => void;
  sidebarStateFilterToggle: (state: string) => void;
  inspectorMesSet: (payload: { id: string; job: MesJob }) => void;
  oemDialogQuerySet: (query: string) => void;
  oemDialogSegmentSet: (segment: string) => void;
  oemDialogVendorSet: (vendor: string) => void;
  archQuerySet: (query: string) => void;
};
export const resetTwinPageStore = page.reset;
