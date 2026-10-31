import type { CutAxis, SceneViewPreset, XRayFilter } from '@/contracts/scene.port';

export type EntryMode = 'visitor' | 'engineer' | 'research';
export type FabLevel = 'L1' | 'B1' | 'DUAL' | 'EXPLODED';
export type SpatialMode = null | 'aerodynamics' | 'exploded' | 'cut' | 'xray';
export type TwinView = Exclude<SceneViewPreset, 'reset' | 'focus'>;
export type StatusSource = 'demo' | 'sse-live' | 'research-replay';

export interface TwinUiState {
  entryMode: EntryMode;
  view: TwinView;
  level: FabLevel;
  spatialMode: SpatialMode;
  cut: { axis: CutAxis; positionM: number; invert: boolean };
  xray: XRayFilter;
  explodePercent: number;
  aeroHeatmap: boolean;
  onboarding: { open: boolean; step: number };
  wafer: { active: boolean; playing: boolean; speed: 1 | 4 | 16 };
  research: { playing: boolean; timeSec: number; speed: 1 | 10 | 100 | 500 };
  statusSource: StatusSource;
  preferredStatusSource: Exclude<StatusSource, 'research-replay'>;
}

export type TwinUiEvent =
  | { type: 'spatial/toggle'; mode: Exclude<SpatialMode, null> }
  | { type: 'spatial/close' }
  | { type: 'level/set'; level: FabLevel }
  | { type: 'view/set'; view: TwinView }
  | { type: 'mode/set'; mode: EntryMode }
  | { type: 'cut/set'; axis: CutAxis; positionM: number; invert: boolean }
  | { type: 'xray/set'; filter: XRayFilter | null }
  | { type: 'explode/set'; percent: number }
  | { type: 'aero/heatmap' }
  | { type: 'tour/scene-step'; level?: 'L1' | 'B1'; view?: TwinView }
  | { type: 'onboarding/open' | 'onboarding/close' }
  | { type: 'onboarding/step'; step: number }
  | { type: 'wafer/open' | 'wafer/close' }
  | { type: 'wafer/play'; playing: boolean }
  | { type: 'wafer/speed'; speed: 1 | 4 | 16 }
  | { type: 'research/play'; playing: boolean }
  | { type: 'research/seek'; timeSec: number }
  | { type: 'research/advance'; deltaSec: number; durationSec: number }
  | { type: 'research/speed'; speed: 1 | 10 | 100 | 500 }
  | { type: 'source/set'; source: Exclude<StatusSource, 'research-replay'> }
  | { type: 'escape' };

export function createTwinUiState(mode: EntryMode = 'engineer'): TwinUiState {
  return {
    entryMode: mode, view: 'iso', level: 'L1', spatialMode: null,
    cut: { axis: 'X', positionM: 0, invert: false }, xray: 'all', explodePercent: 100, aeroHeatmap: false,
    onboarding: { open: false, step: 0 },
    wafer: { active: false, playing: false, speed: 1 },
    research: { playing: false, timeSec: 0, speed: 100 },
    statusSource: mode === 'research' ? 'research-replay' : 'demo', preferredStatusSource: 'demo',
  };
}

function spatialState(state: TwinUiState, mode: SpatialMode): TwinUiState {
  return {
    ...state, spatialMode: mode,
    level: mode === 'exploded' ? 'EXPLODED' : state.level === 'EXPLODED' ? 'L1' : state.level,
    aeroHeatmap: mode === 'aerodynamics' && state.aeroHeatmap,
  };
}

/** Presentation reducer only; long-lived process lifecycles are owned by their runtimes. */
export function twinUiReducer(state: TwinUiState, event: TwinUiEvent): TwinUiState {
  switch (event.type) {
    case 'spatial/toggle': return spatialState(state, state.spatialMode === event.mode ? null : event.mode);
    case 'spatial/close': return spatialState(state, null);
    case 'level/set': return event.level === 'EXPLODED'
      ? spatialState(state, 'exploded') : { ...spatialState(state, null), level: event.level };
    case 'view/set': return { ...state, view: event.view };
    case 'cut/set': return { ...state, cut: { axis: event.axis, positionM: Math.max(-60, Math.min(60, event.positionM)), invert: event.invert } };
    case 'xray/set': return event.filter === null ? spatialState(state, null)
      : { ...spatialState(state, 'xray'), xray: event.filter };
    case 'explode/set': return { ...spatialState(state, 'exploded'), explodePercent: Math.max(0, Math.min(100, event.percent)) };
    case 'aero/heatmap': return { ...spatialState(state, 'aerodynamics'), aeroHeatmap: state.spatialMode !== 'aerodynamics' || !state.aeroHeatmap };
    case 'mode/set': {
      return { ...state, entryMode: event.mode,
        wafer: { ...state.wafer, active: false, playing: false },
        onboarding: { ...state.onboarding, open: false },
        research: { ...state.research, playing: false },
        statusSource: event.mode === 'research' ? 'research-replay' : state.preferredStatusSource,
        view: event.mode === 'research' ? 'iso' : state.view };
    }
    case 'tour/scene-step': return {
      ...spatialState(state, null), level: event.level ?? 'L1', view: event.view ?? 'iso',
      entryMode: state.entryMode === 'research' ? 'visitor' : state.entryMode,
      statusSource: state.preferredStatusSource,
      onboarding: { ...state.onboarding, open: false },
      wafer: { ...state.wafer, active: false, playing: false },
      research: { ...state.research, playing: false },
    };
    case 'onboarding/open': return {
      ...state, onboarding: { open: true, step: 0 },
      wafer: { ...state.wafer, active: false, playing: false }, research: { ...state.research, playing: false },
    };
    case 'onboarding/close': return { ...state, onboarding: { ...state.onboarding, open: false } };
    case 'onboarding/step': return { ...state, onboarding: { ...state.onboarding, step: Math.max(0, Math.min(2, event.step)) } };
    case 'wafer/open': return {
      ...state, entryMode: state.entryMode === 'research' ? 'engineer' : state.entryMode,
      level: 'L1', spatialMode: null, aeroHeatmap: false, statusSource: state.preferredStatusSource,
      wafer: { ...state.wafer, active: true, playing: true },
      onboarding: { ...state.onboarding, open: false }, research: { ...state.research, playing: false },
    };
    case 'wafer/close': return { ...state, view: 'iso', wafer: { ...state.wafer, active: false, playing: false } };
    case 'wafer/play': return { ...state, wafer: { ...state.wafer, playing: state.wafer.active && event.playing } };
    case 'wafer/speed': return { ...state, wafer: { ...state.wafer, speed: event.speed } };
    case 'research/play': return { ...state, research: { ...state.research, playing: state.entryMode === 'research' && event.playing } };
    case 'research/seek': return { ...state, research: { ...state.research, timeSec: Math.max(0, event.timeSec), playing: false } };
    case 'research/advance': {
      if (!state.research.playing || state.entryMode !== 'research') return state;
      const timeSec = Math.min(event.durationSec, state.research.timeSec + Math.max(0, event.deltaSec));
      return { ...state, research: { ...state.research, timeSec, playing: timeSec < event.durationSec } };
    }
    case 'research/speed': return { ...state, research: { ...state.research, speed: event.speed } };
    case 'source/set': return { ...state, preferredStatusSource: event.source,
      statusSource: state.entryMode === 'research' ? 'research-replay' : event.source };
    case 'escape': return { ...state, onboarding: { ...state.onboarding, open: false } };
  }
}

export interface TwinSceneState {
  basement: boolean;
  dual: boolean;
  explodeFactor: number;
  cut: TwinUiState['cut'] & { active: boolean };
  xray: XRayFilter | null;
  airflow: boolean;
  heatmap: boolean;
}

export function projectTwinSceneState(state: TwinUiState): TwinSceneState {
  return {
    basement: state.level === 'B1', dual: state.level === 'DUAL',
    explodeFactor: state.spatialMode === 'exploded' ? state.explodePercent / 100 : 0,
    cut: { ...state.cut, active: state.spatialMode === 'cut' },
    xray: state.spatialMode === 'xray' ? state.xray : null,
    airflow: state.spatialMode === 'aerodynamics' && state.level !== 'B1',
    heatmap: state.spatialMode === 'aerodynamics' && state.aeroHeatmap && state.level !== 'B1',
  };
}
