import type { AmhsStats, PickedTool, SceneLayer } from '../fab-scene';
import { FAB_TOOL_STATES, type FabToolState } from '../fab-layout';
import type { TwinSelection } from '../original-twin-data';
import type { MesJob } from '../process-control';
import { DEFAULT_YIELD_INPUT, type YieldInput } from '../fab-yield';
import type { DefectPattern } from '../wafer-map';
import type { WaferProduct } from '../wafer-route';
import type { WaferHud } from '../tour-wafer-timeline';
import { createSliceStore } from './createSliceStore';

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

type Patch<T> = Partial<T>;
const page = (state: TwinPageState, patch: Patch<TwinPageState>): TwinPageState => ({ ...state, ...patch });
const wafer = (state: TwinPageState, patch: Patch<WaferUiState>): TwinPageState => page(state, { wafer: { ...state.wafer, ...patch } });
const yms = (state: TwinPageState, patch: Patch<YmsUiState>): TwinPageState => page(state, { yms: { ...state.yms, ...patch } });
const sidebar = (state: TwinPageState, patch: Patch<TwinPageState['sidebar']>): TwinPageState => page(state, { sidebar: { ...state.sidebar, ...patch } });
const oemDialog = (state: TwinPageState, patch: Patch<TwinPageState['oemDialog']>): TwinPageState => page(state, { oemDialog: { ...state.oemDialog, ...patch } });

const twinPage = createSliceStore(initialTwinPageState, {
  siteIdSet: (state, action) => page(state, { siteId: action.payload }),
  siteErrorSet: (state, action) => page(state, { siteError: action.payload }),
  liveSnapshotReceived: (state, action) => page(state, {
    liveToolStates: action.payload.states,
    statusFeed: { updatedAt: action.payload.updatedAt, stale: false },
  }),
  replayBaseSet: (state, action) => page(state, { replayBase: [...action.payload] }),
  statusFeedStale: (state) => state.statusFeed
    ? page(state, { statusFeed: { ...state.statusFeed, stale: true } })
    : state,
  selectedSet: (state, action) => page(state, { selected: action.payload }),
  selectionSet: (state, action) => page(state, { selection: action.payload }),
  mesJobSet: (state, action) => page(state, { mesJobs: { ...state.mesJobs, [action.payload.index]: action.payload.job } }),
  layerToggled: (state, action) => {
    const layer = action.payload as SceneLayer;
    return page(state, { layerPreferences: { ...state.layerPreferences, [layer]: !state.layerPreferences[layer] } });
  },
  amhsSet: (state, action) => page(state, { amhs: action.payload }),
  infoDialogSet: (state, action) => page(state, { infoDialog: action.payload }),
  showResearchUtilToggled: (state) => page(state, { showResearchUtil: !state.showResearchUtil }),
  tourRemainingSet: (state, action) => page(state, { tourRemainingMs: Math.max(0, action.payload) }),
  tourTick: (state) => page(state, { tourRemainingMs: Math.max(0, state.tourRemainingMs - 250) }),
  onboardingDontShowSet: (state, action) => page(state, { onboardingDontShow: action.payload }),
  waferFrameReceived: (state, action) => wafer(state, action.payload),
  waferFollowSet: (state, action) => wafer(state, { follow: action.payload }),
  ymsOpenSet: (state, action) => yms(state, { open: action.payload }),
  ymsTabSet: (state, action) => yms(state, { tab: action.payload }),
  ymsRandomize: (state, action) => yms(state, { pattern: action.payload, seed: state.yms.seed + 1 }),
  ymsHoverDieSet: (state, action) => yms(state, { hoverDie: action.payload }),
  ymsDieAreaSet: (state, action) => yms(state, { dieArea: action.payload }),
  ymsDefectD0Set: (state, action) => yms(state, { defectD0: action.payload }),
  ymsClusterAlphaSet: (state, action) => yms(state, { clusterAlpha: action.payload }),
  ymsYieldInputSet: (state, action) => yms(state, { yieldInput: action.payload }),
  ymsYieldScenarioSet: (state, action) => yms(state, { yieldScenario: action.payload }),
  ymsStdfCopiedSet: (state, action) => yms(state, { stdfCopied: action.payload }),
  sidebarTabSet: (state, action) => sidebar(state, { tab: action.payload, query: '', segment: 'ALL', switched: true }),
  sidebarQuerySet: (state, action) => sidebar(state, { query: action.payload }),
  sidebarCategorySet: (state, action) => sidebar(state, { category: action.payload }),
  sidebarSegmentSet: (state, action) => sidebar(state, { segment: action.payload }),
  sidebarStateFilterToggle: (state, action) => sidebar(state, {
    stateFilter: state.sidebar.stateFilter === action.payload ? 'ALL' : action.payload,
  }),
  inspectorMesSet: (state, action) => page(state, { inspectorMes: { ...state.inspectorMes, [action.payload.id]: action.payload.job } }),
  oemDialogQuerySet: (state, action) => oemDialog(state, { query: action.payload }),
  oemDialogSegmentSet: (state, action) => oemDialog(state, { segment: action.payload }),
  oemDialogVendorSet: (state, action) => oemDialog(state, { vendor: action.payload }),
  archQuerySet: (state, action) => page(state, { archQuery: action.payload }),
});

export const useTwinPageStore = twinPage.useStore;
export const twinPageActions = twinPage.actions as {
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
export const resetTwinPageStore = twinPage.reset;
