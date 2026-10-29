import { useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { shallowRecordEqual } from '@/state/atom-equality';
import { localeAtom } from '@/state/locale.atom';
import { viewerSessionAtom } from '@/state/viewer.atom';
import { twinDemoAtom } from '@/twin/twin-demo.atom';
import { twinPageAtom } from '@/twin/twin-page.atom';
import { twinPageUiAtom } from '@/twin/twin-page-ui.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { twinYmsAtom } from '@/twin/twin-yms.atom';
import { useTwinLocale } from '@/twin/twin-i18n';

/**
 * The exact slices TwinContent renders, kept in one place so the subscription
 * granularity stays auditable (and cheap).
 *
 * - UI: only the branches the page layout reads. Wafer playing/speed live with
 *   the wafer HUD child so its 20 Hz frames never rerender the page.
 * - DEMO: states feed the scene projection; keys feed the sidebar/inspector.
 * - FAB: the FAB-scoped server/session projection (status feed, tool states, MES).
 * - PAGE UI: overlays/preferences; merged with FAB for the layout only.
 * - YMS open: the YMS tool owns its own atom; the layout only renders the toggle.
 * - Viewer: the rendering-scope session atom; hover/selection-sync are separate
 *   atoms with their own subscribers and never rerender this page.
 */
export function useTwinSlices() {

  const { t, language, toggleLanguage } = useTwinLocale();
  const theme = useAtomValue(localeAtom, (state) => state.theme);
  const ui = useAtomValue(twinContentUiAtom);
  const demo = useAtomValue(twinContentDemoAtom);
  const fab = useAtomValue(twinFabSliceAtom);
  const overlays = useAtomValue(twinOverlaySliceAtom);
  const ymsOpen = useAtomValue(twinYmsAtom, (state) => state.open);
  const { status, lifecycle, epoch: viewerEpoch } = useAtomValue(viewerSessionAtom);
  const page = { ...fab, ...overlays, ymsOpen };
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

const twinFabSliceAtom = Atom.map(twinPageAtom, (state) => ({
    siteId: state.siteId,
    siteError: state.siteError,
    liveToolStates: state.liveToolStates,
    replayBase: state.replayBase,
    statusFeed: state.statusFeed,
    mesJobs: state.mesJobs,
  })).pipe(Atom.withEquality(shallowRecordEqual));

const twinOverlaySliceAtom = Atom.map(twinPageUiAtom, (state) => ({
    selected: state.selected,
    selection: state.selection,
    layerPreferences: state.layerPreferences,
    infoDialog: state.infoDialog,
    showResearchUtil: state.showResearchUtil,
    onboardingDontShow: state.onboardingDontShow,
  })).pipe(Atom.withEquality(shallowRecordEqual));
