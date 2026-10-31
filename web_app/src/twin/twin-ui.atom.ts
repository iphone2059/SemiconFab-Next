import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
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

export const twinUiAtom = Atom.make<TwinUiState>(initialUi()).pipe(Atom.keepAlive);

const apply = (registry: AtomRegistry.AtomRegistry, event: TwinUiEvent): void => {
  registry.update(twinUiAtom, (state) => twinUiReducer(state, event));
};

export const twinUiActions = {
  modeSet: (registry: AtomRegistry.AtomRegistry, mode: EntryMode) => apply(registry, { type: 'mode/set', mode }),
  viewSet: (registry: AtomRegistry.AtomRegistry, view: TwinView) => apply(registry, { type: 'view/set', view }),
  levelSet: (registry: AtomRegistry.AtomRegistry, level: FabLevel) => apply(registry, { type: 'level/set', level }),
  spatialToggle: (registry: AtomRegistry.AtomRegistry, mode: Exclude<SpatialMode, null>) => apply(registry, { type: 'spatial/toggle', mode }),
  cutSet: (registry: AtomRegistry.AtomRegistry, payload: { axis: CutAxis; positionM: number; invert: boolean }) => apply(registry, { type: 'cut/set', ...payload }),
  xraySet: (registry: AtomRegistry.AtomRegistry, filter: XRayFilter | null) => apply(registry, { type: 'xray/set', filter }),
  explodeSet: (registry: AtomRegistry.AtomRegistry, percent: number) => apply(registry, { type: 'explode/set', percent }),
  aeroHeatmapToggle: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'aero/heatmap' }),
  tourSceneStep: (registry: AtomRegistry.AtomRegistry, payload: { level?: 'L1' | 'B1'; view?: TwinView }) => apply(registry, { type: 'tour/scene-step', ...payload }),
  onboardingOpen: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'onboarding/open' }),
  onboardingClose: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'onboarding/close' }),
  onboardingStep: (registry: AtomRegistry.AtomRegistry, step: number) => apply(registry, { type: 'onboarding/step', step }),
  waferOpen: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'wafer/open' }),
  // Store-only close: the page projection is cleared by the explicit
  // closeWaferSession(registry) use case (twin/twin-wafer-session.ts), not by a
  // hidden cross-store write from this store.
  waferClose: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'wafer/close' }),
  waferPlay: (registry: AtomRegistry.AtomRegistry, playing: boolean) => apply(registry, { type: 'wafer/play', playing }),
  waferSpeedSet: (registry: AtomRegistry.AtomRegistry, speed: 1 | 4 | 16) => apply(registry, { type: 'wafer/speed', speed }),
  researchPlay: (registry: AtomRegistry.AtomRegistry, playing: boolean) => apply(registry, { type: 'research/play', playing }),
  researchSeek: (registry: AtomRegistry.AtomRegistry, timeSec: number) => apply(registry, { type: 'research/seek', timeSec }),
  researchAdvance: (registry: AtomRegistry.AtomRegistry, payload: { deltaSec: number; durationSec: number }) => apply(registry, { type: 'research/advance', ...payload }),
  researchSpeedSet: (registry: AtomRegistry.AtomRegistry, speed: 1 | 10 | 100 | 500) => apply(registry, { type: 'research/speed', speed }),
  sourceSet: (registry: AtomRegistry.AtomRegistry, source: 'demo' | 'sse-live') => apply(registry, { type: 'source/set', source }),
  escape: (registry: AtomRegistry.AtomRegistry) => apply(registry, { type: 'escape' }),
};
