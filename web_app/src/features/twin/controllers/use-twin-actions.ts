import type { RefObject } from 'react';
import type { CutAxis, PickedTool, SceneLayer, XRayFilter } from '../../../application/ports/scene';
import { FAB_LAYOUT, type FabToolState } from '../../../domain/fab/fab-layout';
import { ORIGINAL_TWIN_UI, type TwinSelection } from '../../../domain/fab/original-twin-data';
import { applyMesAction, createMesJob, type MesAction, type MesJob } from '../../../domain/fab/process-control';
import { YIELD_SCENARIOS } from '../../../domain/fab/fab-yield';
import { runtimeActions, useRuntimeStore } from '../../../state/runtimeStore';
import { twinDemoActions } from '../state/twinDemoStore';
import { useTwinPageStore, twinPageActions } from '../state/twinPageStore';
import { twinUiActions } from '../state/twinUiStore';
import type { EntryMode, FabLevel, TwinView } from '../state/twin-state';
import type { FabViewportHandle } from '../fab-viewer';
import { ONBOARDING_KEY } from '../twin-page-data';

export interface TwinActionsParams {
  scene: RefObject<FabViewportHandle | null>;
  mode: EntryMode;
  view: TwinView;
  level: FabLevel;
  exploded: boolean;
  selected?: PickedTool;
  mesJobs: Record<number, MesJob>;
  layerPreferences: Record<SceneLayer, boolean>;
  toolStates: readonly FabToolState[];
  onboardingDontShow: boolean;
  startTour(): void;
}

export interface TwinActions {
  setMode(value: EntryMode): void;
  setCamera(next: TwinView): void;
  toggleLayer(layer: SceneLayer): void;
  applyXRayFilter(filter: XRayFilter | null): void;
  toggleCut(): void;
  updateCut(axis: CutAxis, position: number, invert: boolean): void;
  setL1(): void;
  setB1(): void;
  setDual(): void;
  toggleExploded(): void;
  changeExplode(percent: number): void;
  chooseDemoScenario(id: string): void;
  handleToolChange(tool?: PickedTool): void;
  handleTwinSelection(next: TwinSelection): void;
  handleManualKey(key: string, state: FabToolState): void;
  runMesAction(action: MesAction): void;
  dismissOnboarding(): void;
  finishOnboarding(): void;
  clearSelection(): void;
  escape(): void;
  setWaferFollow(follow: boolean): void;
  setInfoDialog(value: 'architecture' | 'database' | null): void;
  toggleResearchUtil(): void;
  setOnboardingDontShow(value: boolean): void;
  setYmsOpen(value: boolean): void;
  setYmsTab(value: 'map' | 'yield'): void;
}

/**
 * Page command handlers: the small imperative use cases the composition/layout
 * invokes from buttons, dialogs and scene callbacks. They read the render's
 * subscribed values and dispatch typed store actions; no effects or long-lived
 * refs live here (those belong to the dedicated controllers).
 */
export function useTwinActions({
  scene,
  mode,
  view,
  level,
  exploded,
  selected,
  mesJobs,
  layerPreferences,
  toolStates,
  onboardingDontShow,
  startTour,
}: TwinActionsParams): TwinActions {
  const setSelected = (value?: PickedTool) => twinPageActions.selectedSet(value);
  const setSelection = (value?: TwinSelection) => twinPageActions.selectionSet(value);
  const setReplayBase = (value: readonly FabToolState[]) => twinPageActions.replayBaseSet(value);
  const setInfoDialog = (value: 'architecture' | 'database' | null) => twinPageActions.infoDialogSet(value);
  const toggleResearchUtil = () => twinPageActions.showResearchUtilToggled();
  const setOnboardingDontShow = (value: boolean) => twinPageActions.onboardingDontShowSet(value);
  const setYmsOpen = (value: boolean) => twinPageActions.ymsOpenSet(value);
  const setYmsTab = (value: 'map' | 'yield') => twinPageActions.ymsTabSet(value);
  const setWaferFollow = (value: boolean) => twinPageActions.waferFollowSet(value);
  const setMesJobs = (updater: (current: Record<number, MesJob>) => Record<number, MesJob>) => {
    const next = updater(mesJobs);
    for (const [index, job] of Object.entries(next)) twinPageActions.mesJobSet({ index: Number(index), job });
  };
  const setLayers = (updater: (current: Record<SceneLayer, boolean>) => Record<SceneLayer, boolean>) => {
    const next = updater(layerPreferences);
    for (const layer of Object.keys(next) as SceneLayer[]) if (next[layer] !== layerPreferences[layer]) twinPageActions.layerToggled(layer);
  };

  function setMode(value: EntryMode): void {
    if (value === 'research' && mode !== 'research') setReplayBase(toolStates);
    twinUiActions.modeSet(value);
  }

  function setCamera(next: TwinView): void {
    twinUiActions.viewSet(next);
    // Repeating the active preset still re-centres a manually moved camera.
    if (next === view) scene.current?.setView(next);
  }

  function toggleLayer(layer: SceneLayer): void {
    if (layer === 'airflow') { twinUiActions.spatialToggle('aerodynamics'); return; }
    if (layer === 'heatmap') { twinUiActions.aeroHeatmapToggle(); return; }
    if (layer === 'xray') { twinUiActions.spatialToggle('xray'); return; }
    setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }

  function applyXRayFilter(filter: XRayFilter | null): void { twinUiActions.xraySet(filter); }
  function toggleCut(): void { twinUiActions.spatialToggle('cut'); }
  function updateCut(axis: CutAxis, position: number, invert: boolean): void {
    twinUiActions.cutSet({ axis, positionM: position, invert });
  }

  function flyLevel(next: 'L1' | 'B1' | 'DUAL' | 'EXPLODED'): void {
    const poses = {
      L1: { position: [0, 52, 64] as const, target: [0, 2, 0] as const },
      B1: { position: [-15, -2, 34] as const, target: [-15, -6, -5] as const },
      DUAL: { position: [0, 38, 62] as const, target: [0, -3, 0] as const },
      EXPLODED: { position: [55, 44, 72] as const, target: [0, -4, 0] as const },
    };
    const pose = poses[next];
    scene.current?.setCameraPose(pose.position, pose.target, 850);
  }

  // Frozen switchFabLevel/activateSpatialMode semantics: entering Exploded always targets 100%,
  // leaving it resets the preset to 0%; any level switch away also closes the exploded mode.
  function leaveExploded(): void { if (exploded) twinUiActions.explodeSet(0); }
  function setL1(): void { leaveExploded(); twinUiActions.levelSet('L1'); flyLevel('L1'); }
  function setB1(): void { const next = level === 'B1' ? 'L1' : 'B1'; leaveExploded(); twinUiActions.levelSet(next); flyLevel(next); }
  function setDual(): void { const next = level === 'DUAL' ? 'L1' : 'DUAL'; leaveExploded(); twinUiActions.levelSet(next); flyLevel(next); }
  function toggleExploded(): void {
    if (exploded) {
      twinUiActions.explodeSet(0);
      twinUiActions.spatialToggle('exploded');
      flyLevel('L1');
    } else {
      twinUiActions.spatialToggle('exploded');
      flyLevel('EXPLODED');
      twinUiActions.explodeSet(100);
    }
  }
  function changeExplode(percent: number): void { twinUiActions.explodeSet(percent); }

  function handleTwinSelection(next: TwinSelection): void {
    setSelection(next);
    if (next.kind === 'reference') {
      const row = ORIGINAL_TWIN_UI.equipment.find((item) => item.id === next.id);
      const catalogIndex = FAB_LAYOUT.findIndex((tool) => tool.originalKind === 'catalog' && tool.recordId === next.id);
      setSelected(undefined);
      if (catalogIndex >= 0) {
        const token = crypto.randomUUID();
        runtimeActions.viewerSelectionSyncStarted(token);
        scene.current?.selectTool(catalogIndex, false);
        window.setTimeout(() => runtimeActions.viewerSelectionSyncFinished(token), 0);
      }
      else scene.current?.clearSelection();
      if (row?.level === 'B1') { twinUiActions.levelSet('B1'); flyLevel('B1'); scene.current?.setDual(false); scene.current?.setBasement(true); }
    } else if (next.kind === 'oem') {
      setSelected(undefined);
      scene.current?.clearSelection();
    }
  }

  function handleToolChange(tool?: PickedTool): void {
    setSelected(tool);
    const sync = useRuntimeStore.getState().viewer.selectionSync;
    if (sync) { runtimeActions.viewerSelectionSyncFinished(sync); return; }
    // A05: the scene keeps this callback across renders, so read the latest
    // selection from the store instead of the render closure.
    const currentSelection = useTwinPageStore.getState().selection;
    if (tool && currentSelection?.kind === 'reference' && FAB_LAYOUT[tool.index]?.recordId === currentSelection.id) return;
    if (tool) setSelection({ kind: 'layout', index: tool.index });
    else if (currentSelection?.kind === 'layout') setSelection(undefined);
  }

  function handleManualKey(key: string, state: FabToolState): void {
    twinDemoActions.manualKeySet({ key, state });
  }

  function runMesAction(action: MesAction): void {
    if (!selected) return;
    const index = selected.index;
    setMesJobs((current) => ({
      ...current,
      [index]: applyMesAction(current[index] ?? createMesJob(FAB_LAYOUT[index], index, Date.now()), action),
    }));
  }

  function chooseDemoScenario(id: string): void {
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === id);
    if (!scenario) return;
    twinUiActions.sourceSet('demo');
    twinDemoActions.scenarioApplied(scenario);
    twinPageActions.ymsYieldScenarioSet('live');
    twinPageActions.ymsYieldInputSet({ purity: scenario.purity, health: scenario.health, lagTime: scenario.lagTime });
  }

  function dismissOnboarding(): void {
    twinUiActions.onboardingClose();
    try { if (onboardingDontShow) localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* ignore storage denial */ }
  }

  function finishOnboarding(): void {
    dismissOnboarding();
    startTour();
  }

  function clearSelection(): void {
    scene.current?.clearSelection();
    setSelected(undefined);
    setSelection(undefined);
  }

  function escape(): void {
    twinUiActions.escape();
    scene.current?.clearSelection();
    setSelected(undefined);
    setSelection(undefined);
    setYmsOpen(false);
    setInfoDialog(null);
  }

  return {
    setMode,
    setCamera,
    toggleLayer,
    applyXRayFilter,
    toggleCut,
    updateCut,
    setL1,
    setB1,
    setDual,
    toggleExploded,
    changeExplode,
    chooseDemoScenario,
    handleToolChange,
    handleTwinSelection,
    handleManualKey,
    runMesAction,
    dismissOnboarding,
    finishOnboarding,
    clearSelection,
    escape,
    setWaferFollow,
    setInfoDialog,
    toggleResearchUtil,
    setOnboardingDontShow,
    setYmsOpen,
    setYmsTab,
  };
}
