import { DEFAULT_YIELD_INPUT, type YieldInput } from '@/domain/fab-yield';
import type { DefectPattern } from '@/domain/wafer-map';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * YMS (wafer-map / yield-waterfall) analysis tool state.
 *
 * Owner: the YMS dialog children. Slider/hover edits are user-driven and only
 * that dialog (plus the header yield pill's derived preferences) subscribes, so
 * they must not notify the page/FAB projections. Split out of the former single
 * TwinPageState for that reason.
 */
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

export const initialYmsUiState: YmsUiState = {
  open: false, tab: 'map', pattern: 'clean', seed: 811, dieArea: 100, defectD0: 0.15, clusterAlpha: 3,
  yieldInput: DEFAULT_YIELD_INPUT, yieldScenario: 'live', stdfCopied: false,
};

const yms = (state: YmsUiState, patch: Partial<YmsUiState>): YmsUiState => ({ ...state, ...patch });

const reducers = {
  ymsOpenSet: (state: YmsUiState, open: boolean) => yms(state, { open }),
  ymsTabSet: (state: YmsUiState, tab: 'map' | 'yield') => yms(state, { tab }),
  ymsRandomize: (state: YmsUiState, pattern: DefectPattern) => yms(state, { pattern, seed: state.seed + 1 }),
  ymsHoverDieSet: (state: YmsUiState, hoverDie?: YmsUiState['hoverDie']) => yms(state, { hoverDie }),
  ymsDieAreaSet: (state: YmsUiState, dieArea: number) => yms(state, { dieArea }),
  ymsDefectD0Set: (state: YmsUiState, defectD0: number) => yms(state, { defectD0 }),
  ymsClusterAlphaSet: (state: YmsUiState, clusterAlpha: number) => yms(state, { clusterAlpha }),
  ymsYieldInputSet: (state: YmsUiState, yieldInput: YieldInput) => yms(state, { yieldInput }),
  ymsYieldScenarioSet: (state: YmsUiState, yieldScenario: string) => yms(state, { yieldScenario }),
  ymsStdfCopiedSet: (state: YmsUiState, stdfCopied: boolean) => yms(state, { stdfCopied }),
};

export const twinYmsAtom = Atom.make<YmsUiState>(initialYmsUiState).pipe(Atom.keepAlive);

export const twinYmsActions = {
  ymsOpenSet: (registry: AtomRegistry.AtomRegistry, open: boolean): void => {
    registry.update(twinYmsAtom, state => reducers.ymsOpenSet(state, open));
  },
  ymsTabSet: (registry: AtomRegistry.AtomRegistry, tab: 'map' | 'yield'): void => {
    registry.update(twinYmsAtom, state => reducers.ymsTabSet(state, tab));
  },
  ymsRandomize: (registry: AtomRegistry.AtomRegistry, pattern: DefectPattern): void => {
    registry.update(twinYmsAtom, state => reducers.ymsRandomize(state, pattern));
  },
  ymsHoverDieSet: (registry: AtomRegistry.AtomRegistry, hoverDie?: YmsUiState['hoverDie']): void => {
    registry.update(twinYmsAtom, state => reducers.ymsHoverDieSet(state, hoverDie));
  },
  ymsDieAreaSet: (registry: AtomRegistry.AtomRegistry, dieArea: number): void => {
    registry.update(twinYmsAtom, state => reducers.ymsDieAreaSet(state, dieArea));
  },
  ymsDefectD0Set: (registry: AtomRegistry.AtomRegistry, defectD0: number): void => {
    registry.update(twinYmsAtom, state => reducers.ymsDefectD0Set(state, defectD0));
  },
  ymsClusterAlphaSet: (registry: AtomRegistry.AtomRegistry, clusterAlpha: number): void => {
    registry.update(twinYmsAtom, state => reducers.ymsClusterAlphaSet(state, clusterAlpha));
  },
  ymsYieldInputSet: (registry: AtomRegistry.AtomRegistry, yieldInput: YieldInput): void => {
    registry.update(twinYmsAtom, state => reducers.ymsYieldInputSet(state, yieldInput));
  },
  ymsYieldScenarioSet: (registry: AtomRegistry.AtomRegistry, yieldScenario: string): void => {
    registry.update(twinYmsAtom, state => reducers.ymsYieldScenarioSet(state, yieldScenario));
  },
  ymsStdfCopiedSet: (registry: AtomRegistry.AtomRegistry, stdfCopied: boolean): void => {
    registry.update(twinYmsAtom, state => reducers.ymsStdfCopiedSet(state, stdfCopied));
  },
};
