import { create } from 'zustand';
import type { CutAxis, XRayFilter } from '@/contracts/scene.port';
import {
  createTwinUiState,
  twinUiReducer,
  type EntryMode,
  type FabLevel,
  type SpatialMode,
  type TwinUiEvent,
  type TwinUiState,
  type TwinView,
} from '@/twin/twin-state';

function initialUi(): TwinUiState {
  // URL mode is applied by the Router-aware TwinPage; the store must not read location.
  return createTwinUiState('engineer');
}

export const useTwinUiStore = create<TwinUiState>()(() => initialUi());

const apply = (event: TwinUiEvent): void => {
  useTwinUiStore.setState((state) => twinUiReducer(state, event));
};

export const twinUiActions = {
  modeSet: (mode: EntryMode) => apply({ type: 'mode/set', mode }),
  viewSet: (view: TwinView) => apply({ type: 'view/set', view }),
  levelSet: (level: FabLevel) => apply({ type: 'level/set', level }),
  spatialToggle: (mode: Exclude<SpatialMode, null>) => apply({ type: 'spatial/toggle', mode }),
  cutSet: (payload: { axis: CutAxis; positionM: number; invert: boolean }) => apply({ type: 'cut/set', ...payload }),
  xraySet: (filter: XRayFilter | null) => apply({ type: 'xray/set', filter }),
  explodeSet: (percent: number) => apply({ type: 'explode/set', percent }),
  aeroHeatmapToggle: () => apply({ type: 'aero/heatmap' }),
  tourStep: (payload: { waypoint: number; level?: 'L1' | 'B1'; view?: TwinView }) => apply({ type: 'tour/step', ...payload }),
  tourStop: () => apply({ type: 'tour/stop' }),
  onboardingOpen: () => apply({ type: 'onboarding/open' }),
  onboardingClose: () => apply({ type: 'onboarding/close' }),
  onboardingStep: (step: number) => apply({ type: 'onboarding/step', step }),
  waferOpen: () => apply({ type: 'wafer/open' }),
  // Store-only close: the page projection is cleared by the explicit
  // closeWaferSession() use case (features/twin/wafer-session.ts), not by a
  // hidden cross-store write from this store.
  waferClose: () => apply({ type: 'wafer/close' }),
  waferPlay: (playing: boolean) => apply({ type: 'wafer/play', playing }),
  waferSpeedSet: (speed: 1 | 4 | 16) => apply({ type: 'wafer/speed', speed }),
  researchPlay: (playing: boolean) => apply({ type: 'research/play', playing }),
  researchSeek: (timeSec: number) => apply({ type: 'research/seek', timeSec }),
  researchAdvance: (payload: { deltaSec: number; durationSec: number }) => apply({ type: 'research/advance', ...payload }),
  researchSpeedSet: (speed: 1 | 10 | 100 | 500) => apply({ type: 'research/speed', speed }),
  sourceSet: (source: 'demo' | 'sse-live') => apply({ type: 'source/set', source }),
  escape: () => apply({ type: 'escape' }),
};

export const resetTwinUiStore = (): void => useTwinUiStore.setState(initialUi(), true);
