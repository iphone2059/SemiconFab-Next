import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AmhsStats, CutAxis, PickedTool, SceneLayer, XRayFilter } from '../fab-scene';
import { FAB_TOOL_STATES, type FabToolState } from '../fab-layout';
import { createTwinUiState, twinUiReducer, type EntryMode, type FabLevel, type SpatialMode, type TwinUiEvent, type TwinUiState, type TwinView } from '../twin-state';
import type { TwinSelection } from '../original-twin-data';
import type { MesJob } from '../process-control';
import { applyMesAction, createMesJob } from '../process-control';
import { DEFAULT_YIELD_INPUT, type YieldInput } from '../fab-yield';
import type { DefectPattern } from '../wafer-map';
import type { WaferProduct } from '../wafer-route';

function initialUi(): TwinUiState {
  const requested = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('mode');
  return createTwinUiState(requested === 'visitor' || requested === 'research' ? requested : 'engineer');
}

function reduce(state: TwinUiState, event: TwinUiEvent): TwinUiState {
  return twinUiReducer(state, event);
}

export const twinUiSlice = createSlice({
  name: 'twinUi',
  initialState: initialUi,
  reducers: {
    modeSet(state, action: PayloadAction<EntryMode>) { return reduce(state, { type: 'mode/set', mode: action.payload }); },
    viewSet(state, action: PayloadAction<TwinView>) { return reduce(state, { type: 'view/set', view: action.payload }); },
    levelSet(state, action: PayloadAction<FabLevel>) { return reduce(state, { type: 'level/set', level: action.payload }); },
    spatialToggle(state, action: PayloadAction<Exclude<SpatialMode, null>>) { return reduce(state, { type: 'spatial/toggle', mode: action.payload }); },
    spatialClose(state) { return reduce(state, { type: 'spatial/close' }); },
    cutSet(state, action: PayloadAction<{ axis: CutAxis; positionM: number; invert: boolean }>) { return reduce(state, { type: 'cut/set', ...action.payload }); },
    xraySet(state, action: PayloadAction<XRayFilter | null>) { return reduce(state, { type: 'xray/set', filter: action.payload }); },
    explodeSet(state, action: PayloadAction<number>) { return reduce(state, { type: 'explode/set', percent: action.payload }); },
    aeroHeatmapToggle(state) { return reduce(state, { type: 'aero/heatmap' }); },
    tourStep(state, action: PayloadAction<{ waypoint: number; level?: 'L1' | 'B1'; view?: TwinView }>) { return reduce(state, { type: 'tour/step', ...action.payload }); },
    tourStop(state) { return reduce(state, { type: 'tour/stop' }); },
    onboardingOpen(state) { return reduce(state, { type: 'onboarding/open' }); },
    onboardingClose(state) { return reduce(state, { type: 'onboarding/close' }); },
    onboardingStep(state, action: PayloadAction<number>) { return reduce(state, { type: 'onboarding/step', step: action.payload }); },
    waferOpen(state) { return reduce(state, { type: 'wafer/open' }); },
    waferClose(state) { return reduce(state, { type: 'wafer/close' }); },
    waferPlay(state, action: PayloadAction<boolean>) { return reduce(state, { type: 'wafer/play', playing: action.payload }); },
    waferSpeedSet(state, action: PayloadAction<1 | 4 | 16>) { return reduce(state, { type: 'wafer/speed', speed: action.payload }); },
    researchPlay(state, action: PayloadAction<boolean>) { return reduce(state, { type: 'research/play', playing: action.payload }); },
    researchSeek(state, action: PayloadAction<number>) { return reduce(state, { type: 'research/seek', timeSec: action.payload }); },
    researchAdvance(state, action: PayloadAction<{ deltaSec: number; durationSec: number }>) { return reduce(state, { type: 'research/advance', ...action.payload }); },
    researchSpeedSet(state, action: PayloadAction<1 | 10 | 100 | 500>) { return reduce(state, { type: 'research/speed', speed: action.payload }); },
    sourceSet(state, action: PayloadAction<'demo' | 'sse-live'>) { return reduce(state, { type: 'source/set', source: action.payload }); },
    escape(state) { return reduce(state, { type: 'escape' }); },
  },
});

export type WaferUiState = {
  product: WaferProduct;
  index: number;
  follow: boolean;
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
  status: string;
  liveToolStates: FabToolState[];
  replayBase: FabToolState[];
  statusFeed?: { updatedAt: string; stale: boolean };
  selected?: PickedTool;
  selection?: TwinSelection;
  mesJobs: Record<number, MesJob>;
  layerPreferences: Record<SceneLayer, boolean>;
  amhs?: AmhsStats;
  infoDialog: 'architecture' | 'database' | null;
  researchLoading: boolean;
  researchError: string;
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
}

const initialPageState: TwinPageState = {
  status: '准备 WebGPU 视图…',
  liveToolStates: [...FAB_TOOL_STATES],
  replayBase: [...FAB_TOOL_STATES],
  mesJobs: {},
  layerPreferences: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false },
  infoDialog: null,
  researchLoading: false,
  researchError: '',
  showResearchUtil: true,
  tourRemainingMs: 0,
  onboardingDontShow: true,
  wafer: { product: 'A', index: 0, follow: true },
  yms: { open: false, tab: 'map', pattern: 'clean', seed: 811, dieArea: 100, defectD0: 0.15, clusterAlpha: 3, yieldInput: DEFAULT_YIELD_INPUT, yieldScenario: 'live', stdfCopied: false },
  sidebar: { tab: 'fab', query: '', category: 'ALL', segment: 'ALL', stateFilter: 'ALL', switched: false },
  inspectorMes: {},
};

export const twinPageSlice = createSlice({
  name: 'twinPage',
  initialState: initialPageState,
  reducers: {
    siteIdSet(state, action: PayloadAction<string | undefined>) { state.siteId = action.payload; },
    siteErrorSet(state, action: PayloadAction<string | undefined>) { state.siteError = action.payload; },
    statusSet(state, action: PayloadAction<string>) { state.status = action.payload; },
    liveStatesSet(state, action: PayloadAction<FabToolState[]>) { state.liveToolStates = action.payload; },
    liveSnapshotReceived(state, action: PayloadAction<{ states: FabToolState[]; updatedAt: string }>) {
      state.liveToolStates = action.payload.states;
      state.statusFeed = { updatedAt: action.payload.updatedAt, stale: false };
    },
    replayBaseSet(state, action: PayloadAction<readonly FabToolState[]>) { state.replayBase = [...action.payload]; },
    statusFeedSet(state, action: PayloadAction<{ updatedAt: string; stale: boolean } | undefined>) { state.statusFeed = action.payload; },
    statusFeedStale(state) { if (state.statusFeed) state.statusFeed = { ...state.statusFeed, stale: true }; },
    selectedSet(state, action: PayloadAction<PickedTool | undefined>) { state.selected = action.payload; },
    selectionSet(state, action: PayloadAction<TwinSelection | undefined>) { state.selection = action.payload; },
    mesJobSet(state, action: PayloadAction<{ index: number; job: MesJob }>) { state.mesJobs[action.payload.index] = action.payload.job; },
    layerToggled(state, action: PayloadAction<SceneLayer>) { const layer = action.payload; state.layerPreferences[layer] = !state.layerPreferences[layer]; },
    amhsSet(state, action: PayloadAction<AmhsStats | undefined>) { state.amhs = action.payload; },
    infoDialogSet(state, action: PayloadAction<'architecture' | 'database' | null>) { state.infoDialog = action.payload; },
    researchLoadingSet(state, action: PayloadAction<boolean>) { state.researchLoading = action.payload; },
    researchErrorSet(state, action: PayloadAction<string>) { state.researchError = action.payload; },
    showResearchUtilToggled(state) { state.showResearchUtil = !state.showResearchUtil; },
    tourRemainingSet(state, action: PayloadAction<number>) { state.tourRemainingMs = Math.max(0, action.payload); },
    tourTick(state) { state.tourRemainingMs = Math.max(0, state.tourRemainingMs - 250); },
    onboardingDontShowSet(state, action: PayloadAction<boolean>) { state.onboardingDontShow = action.payload; },
    waferProductSet(state, action: PayloadAction<WaferProduct>) { state.wafer.product = action.payload; state.wafer.index = 0; },
    waferIndexSet(state, action: PayloadAction<number>) { state.wafer.index = Math.max(0, action.payload); },
    waferFollowSet(state, action: PayloadAction<boolean>) { state.wafer.follow = action.payload; },
    ymsOpenSet(state, action: PayloadAction<boolean>) { state.yms.open = action.payload; },
    ymsTabSet(state, action: PayloadAction<'map' | 'yield'>) { state.yms.tab = action.payload; },
    ymsPatternSet(state, action: PayloadAction<DefectPattern>) { state.yms.pattern = action.payload; },
    ymsRandomize(state, action: PayloadAction<DefectPattern>) { state.yms.pattern = action.payload; state.yms.seed += 1; },
    ymsSeedIncremented(state) { state.yms.seed += 1; },
    ymsHoverDieSet(state, action: PayloadAction<YmsUiState['hoverDie']>) { state.yms.hoverDie = action.payload; },
    ymsDieAreaSet(state, action: PayloadAction<number>) { state.yms.dieArea = action.payload; },
    ymsDefectD0Set(state, action: PayloadAction<number>) { state.yms.defectD0 = action.payload; },
    ymsClusterAlphaSet(state, action: PayloadAction<number>) { state.yms.clusterAlpha = action.payload; },
    ymsYieldInputSet(state, action: PayloadAction<YieldInput>) { state.yms.yieldInput = action.payload; },
    ymsYieldScenarioSet(state, action: PayloadAction<string>) { state.yms.yieldScenario = action.payload; },
    ymsStdfCopiedSet(state, action: PayloadAction<boolean>) { state.yms.stdfCopied = action.payload; },
    sidebarTabSet(state, action: PayloadAction<'fab' | 'oem'>) { state.sidebar.tab = action.payload; state.sidebar.query = ''; state.sidebar.segment = 'ALL'; state.sidebar.switched = true; },
    sidebarQuerySet(state, action: PayloadAction<string>) { state.sidebar.query = action.payload; },
    sidebarCategorySet(state, action: PayloadAction<string>) { state.sidebar.category = action.payload; },
    sidebarSegmentSet(state, action: PayloadAction<string>) { state.sidebar.segment = action.payload; },
    sidebarStateFilterToggle(state, action: PayloadAction<string>) { state.sidebar.stateFilter = state.sidebar.stateFilter === action.payload ? 'ALL' : action.payload; },
    inspectorMesSet(state, action: PayloadAction<{ id: string; job: MesJob }>) { state.inspectorMes[action.payload.id] = action.payload.job; },
  },
});

/** Applies a MES action to the selected layout index without keeping a parallel reducer. */
export function applyMesJobAction(input: { jobs: Record<number, MesJob>; index: number; tool: Parameters<typeof createMesJob>[0]; action: Parameters<typeof applyMesAction>[1] }) {
  const job = applyMesAction(input.jobs[input.index] ?? createMesJob(input.tool, input.index), input.action);
  return { index: input.index, job };
}

export const twinUiActions = twinUiSlice.actions;
export const twinPageActions = twinPageSlice.actions;
