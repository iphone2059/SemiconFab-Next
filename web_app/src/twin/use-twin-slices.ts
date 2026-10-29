import { useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { shallowRecordEqual } from '@/state/atom-equality';
import { localeAtom } from '@/state/locale.atom';
import { runtimeAtom } from '@/state/runtime-store';
import { twinDemoAtom } from '@/twin/twin-demo.atom';
import { twinPageAtom } from '@/twin/twin-page.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { useTwinLocale } from '@/twin/twin-i18n';

/**
 * The exact store slices TwinContent renders, kept in one place so the
 * subscription granularity stays auditable (and cheap):
 *
 * - UI: only the branches the page layout reads. Wafer playing/speed live with
 *   the wafer HUD child so its 20 Hz frames never rerender the page.
 * - DEMO: states feed the scene projection; keys feed the sidebar/inspector.
 *   referenceLights/yieldJitter are only used by the extracted yield children.
 * - Page: only the fields TwinContent itself renders. The wafer HUD, AMHS
 *   readouts, YMS dialog and yield pill own their slices in children, so their
 *   high-frequency or nested updates never rerender this page or FabViewport.
 */
export function useTwinSlices() {

  const { t, language, toggleLanguage } = useTwinLocale();
  const theme = useAtomValue(localeAtom, (state) => state.theme);
  const ui = useAtomValue(twinContentUiAtom);
  const demo = useAtomValue(twinContentDemoAtom);
  const page = useAtomValue(twinContentPageAtom);
  const status = useAtomValue(runtimeAtom, state => state.viewer.status);
  const lifecycle = useAtomValue(runtimeAtom, state => state.viewer.lifecycle);
  const viewerEpoch = useAtomValue(runtimeAtom, state => state.viewer.epoch);
  return { t, language, toggleLanguage, theme, ui, demo, page, status, lifecycle, viewerEpoch };
}

const twinContentUiAtom = Atom.map(twinUiAtom, (state) => ({
    entryMode: state.entryMode,
    view: state.view,
    level: state.level,
    spatialMode: state.spatialMode,
    cut: state.cut,
    xray: state.xray,
    explodePercent: state.explodePercent,
    aeroHeatmap: state.aeroHeatmap,
    tour: state.tour,
    onboarding: state.onboarding,
    waferActive: state.wafer.active,
    research: state.research,
    statusSource: state.statusSource,
    preferredStatusSource: state.preferredStatusSource,
  })).pipe(Atom.withEquality(shallowRecordEqual));

const twinContentDemoAtom = Atom.map(twinDemoAtom, (state) => ({
    states: state.states,
    keys: state.keys,
    cycle: state.cycle,
    playing: state.playing,
    scenarioId: state.scenarioId,
  })).pipe(Atom.withEquality(shallowRecordEqual));

const twinContentPageAtom = Atom.map(twinPageAtom, (state) => ({
    siteId: state.siteId,
    siteError: state.siteError,
    liveToolStates: state.liveToolStates,
    replayBase: state.replayBase,
    statusFeed: state.statusFeed,
    selected: state.selected,
    selection: state.selection,
    mesJobs: state.mesJobs,
    layerPreferences: state.layerPreferences,
    infoDialog: state.infoDialog,
    showResearchUtil: state.showResearchUtil,
    onboardingDontShow: state.onboardingDontShow,
    ymsOpen: state.yms.open,
  })).pipe(Atom.withEquality(shallowRecordEqual));
