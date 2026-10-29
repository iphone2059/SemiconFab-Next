import { useShallow } from 'zustand/react/shallow';
import { useLocaleStore } from '@/state/locale.atom';
import { useRuntimeStore } from '@/state/runtime-store';
import { useTwinDemoStore } from '@/twin/twin-demo.atom';
import { useTwinPageStore } from '@/twin/twin-page.atom';
import { useTwinUiStore } from '@/twin/twin-ui.atom';
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
  const theme = useLocaleStore((state) => state.theme);
  const ui = useTwinUiStore(useShallow((state) => ({
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
  })));
  const demo = useTwinDemoStore(useShallow((state) => ({
    states: state.states,
    keys: state.keys,
    cycle: state.cycle,
    playing: state.playing,
    scenarioId: state.scenarioId,
  })));
  const page = useTwinPageStore(useShallow((state) => ({
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
  })));
  const status = useRuntimeStore(state => state.viewer.status);
  const lifecycle = useRuntimeStore(state => state.viewer.lifecycle);
  const viewerEpoch = useRuntimeStore(state => state.viewer.epoch);
  return { t, language, toggleLanguage, theme, ui, demo, page, status, lifecycle, viewerEpoch };
}
