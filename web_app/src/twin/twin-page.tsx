import { RegistryContext, useAtomValue } from '@effect/atom-react';
import { useContext } from 'react';
import { OriginalIcon } from '@/components/original-icons';
import { TwinLocaleProvider } from '@/twin/twin-i18n';
import { useEffect, useMemo, useRef } from 'react';
import type { AmhsStats, CutAxis } from '@/contracts/scene.port';
import { FAB_TOOL_STATE_META, type FabToolState } from '@/domain/fab-layout';
import { YIELD_SCENARIOS } from '@/domain/fab-yield';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from '@/domain/simulation-original-tour';
import { layoutIdentitiesForFab } from '@/domain/fab-layout-identities';
import { cleanroomPressureField } from '@/domain/fab-cleanroom-pressure';
import { createTwinUiState, projectTwinSceneState, type EntryMode } from '@/twin/twin-state';
import { classNames } from '@/components/class-names';
import type { RouterSearch } from '@/routes/route-search';
import { twinAmhsActions } from '@/twin/twin-amhs.atom';
import { twinPageAtom } from '@/twin/twin-page.atom';
import { twinDemoAtom, twinDemoActions } from '@/twin/twin-demo.atom';
import { twinUiAtom, twinUiActions } from '@/twin/twin-ui.atom';
import { createCoalescedDispatcher } from '@/lib/coalesced-dispatcher';
import { useFabTelemetry } from '@/app/telemetry-provider';
import { FabViewport, type FabViewportHandle } from '@/twin/twin-viewer';
import { EquipmentStatusPipeline } from '@/twin/twin-equipment-status-pipeline';
import { TwinSidebar } from '@/twin/twin-sidebar';
import { OriginalInspector } from '@/twin/twin-inspector';
import { TwinInfoDialog } from '@/twin/twin-dialogs';
import { createToolStateMerger } from '@/twin/tool-state-merge';
import { AmhsOhtReadout } from '@/twin/twin-amhs-hud';
import { TwinTourHud } from '@/twin/twin-tour-hud';
import { TwinWaferHud } from '@/twin/twin-wafer-hud';
import { TwinYmsPanel, TwinYieldPill } from '@/twin/twin-yms';
import { CATEGORY_LABELS, LAYER_LABELS, ONBOARDING_STEPS, XRAY_FILTERS } from '@/twin/twin-page-data';
import { useTwinActions } from '@/twin/use-twin-actions';
import { useTwinDemoClock } from '@/twin/use-twin-demo-clock';
import { useTwinKeyboard } from '@/twin/use-twin-keyboard';
import { useTwinProcessProjection } from '@/twin/use-twin-process-projection';
import { TwinResearchFooter, TwinResearchHud } from '@/twin/twin-research-hud';
import { readResearchToolStates, twinResearchAtom } from '@/twin/twin-research.atom';
import { useTourController } from '@/twin/use-tour-controller';
import { useTwinRouteState } from '@/twin/use-twin-route-state';
import { useTwinSlices } from '@/twin/use-twin-slices';
import { useTwinSceneSync } from '@/twin/use-twin-scene-sync';
import { useWaferPlayback } from '@/twin/use-wafer-playback';

interface TwinContentProps {
  /** Canonical route siteId; with fabId it is the composite FAB identity. */
  siteId?: string;
  fabId?: string;
  /** Router-owned search state; the page never reads window.location for product state. */
  search?: RouterSearch;
  onSearchChange?: (patch: Partial<RouterSearch>, replace?: boolean) => void;
}

/**
 * 3D FAB page = composition/layout + projections.
 *
 * The page composes route state, the WebGPU viewer, scoped process runtimes and
 * read-only Atom projections. Tour and Wafer actors, timelines and RAFs belong to
 * their Effect-scoped runtimes; React only mounts adapters and connects HUD/scene ports.
 */
function TwinContent({ siteId, fabId, search, onSearchChange }: TwinContentProps) {
  const registry = useContext(RegistryContext);
  const scene = useRef<FabViewportHandle>(null);
  const { t, language, toggleLanguage, theme, ui, demo, page, status, lifecycle, viewerEpoch } = useTwinSlices();
  const mode = ui.entryMode;
  const view = ui.view;
  const level = ui.level;
  const explodePercent = ui.explodePercent;
  const cutActive = ui.spatialMode === 'cut';
  const { axis: cutAxis, positionM: cutPosition, invert: cutInvert } = ui.cut;
  const xrayFilter = ui.spatialMode === 'xray' ? ui.xray : null;
  const tourStep = ui.tour.active ? ui.tour.waypoint : undefined;
  const onboarding = ui.onboarding.open;
  const onboardingStep = ui.onboarding.step;
  const exploded = ui.spatialMode === 'exploded';
  const basement = ui.level === 'B1';
  const waferActive = ui.waferActive;
  const { siteId: pageSiteId, siteError: error, liveToolStates, replayBase, statusFeed, selected, selection, mesJobs, layerPreferences, infoDialog, showResearchUtil, onboardingDontShow, ymsOpen } = page;

  const { site, fab, selectedFabId } = useTwinRouteState({
    siteId, fabId, pageSiteId, search, onSearchChange, mode, language, theme, t,
  });
  // The telemetry runtime is scoped to the exact composite identity the route
  // resolved: two sites may both configure a FAB with the same fabId.
  const telemetryIdentity = site && fab ? { siteId: site.siteId, fabId: fab.fabId } : undefined;
  const telemetry = useFabTelemetry(telemetryIdentity);
  // R3-10: instance ids are FAB-scoped (a FAB-02 viewer must not show FAB-01 tool ids).
  const layoutIdentities = useMemo(() => layoutIdentitiesForFab(fab?.code ?? 'FAB-01'), [fab?.code]);
  // The tour controller is scoped to the viewer it writes to: a FAB switch or a
  // viewer recreation (new epoch) must stop the running tour, not drive the new scene.
  const playbackScopeKey = `${site?.siteId ?? ''}:${selectedFabId ?? ''}:${viewerEpoch ?? ''}`;
  const {
    ready: tourReady, tourHudRef, tourHudSeed, startTour, endTour, previousTour, advanceTour, finishTour, cancelTourIfRunning,
  } = useTourController({ scene, language, scopeKey: playbackScopeKey });
  const wafer = useWaferPlayback({ scene, waferActive, language, endTour: finishTour, scopeKey: playbackScopeKey, t });
  const researchStates = useAtomValue(twinResearchAtom, value => value.scopeKey === playbackScopeKey ? value.replayProjection?.states : undefined);

  // projectTwinSceneState only reads the level/spatial/cut/xray/explode branches;
  // rebuilding the snapshot from the subscribed values keeps the same projection
  // without a whole-store subscription.
  const projected = projectTwinSceneState({
    ...createTwinUiState(ui.entryMode),
    level: ui.level,
    spatialMode: ui.spatialMode,
    cut: ui.cut,
    xray: ui.xray,
    explodePercent: ui.explodePercent,
    aeroHeatmap: ui.aeroHeatmap,
  });
  const layers = (({ ...layerPreferences, airflow: projected.airflow, heatmap: projected.heatmap, xray: projected.xray !== null }));

  const toolStates = ui.statusSource === 'research-replay' ? researchStates ?? replayBase
    : ui.statusSource === 'demo' ? demo.states : liveToolStates;
  const { selectedTelemetry, selectedSpc, selectedMes, spcPlot } = useTwinProcessProjection({ selected, toolStates, mesJobs });
  const actions = useTwinActions({
    scene, mode, view, level, exploded, selected, mesJobs, layerPreferences, toolStates,
    onboardingDontShow, startTour, endTour: finishTour,
  });
  useTwinSceneSync({
    scene, lifecycle, viewerEpoch, view, language, level, basement, exploded, explodePercent,
    cutActive, cutAxis, cutPosition, cutInvert, xrayFilter,
    tourActive: ui.tour.active, cancelTourIfRunning,
  });
  useTwinKeyboard({ onEscape: actions.escape, setCamera: actions.setCamera });
  useTwinDemoClock(ui.statusSource, demo.playing);

  // Owner object: its timer/coalescing identity must survive renders.
  const amhsBatcher = useMemo(() => createCoalescedDispatcher<AmhsStats>((stats) => twinAmhsActions.amhsSet(registry, stats), 100), [registry]);
  useEffect(() => () => amhsBatcher.cancel(), [amhsBatcher, registry]);

  // Owner closure: caches the last merged frame array across the scene loop.
  const mergeToolStates = useMemo(() => createToolStateMerger(), []);
  const getToolStates = ((): readonly FabToolState[] => {
    if (registry.get(twinUiAtom).entryMode === 'research') return readResearchToolStates(registry, playbackScopeKey, registry.get(twinPageAtom).replayBase);
    if (registry.get(twinUiAtom).statusSource === 'demo') return registry.get(twinDemoAtom).states;
    const base = registry.get(twinPageAtom).liveToolStates;
    // Telemetry Worker output is read inside the scene frame loop; no React
    // state update is involved on the high-frequency path (ARCH-11). The merger
    // keeps the previous array while neither source reference changed.
    return mergeToolStates(base, telemetry?.getToolStates());
  });

  const stateCounts: Record<FabToolState, number> = { running: 0, idle: 0, down: 0, maint: 0 };
  for (const state of toolStates) stateCounts[state] += 1;
  const pressure = cleanroomPressureField(selected?.x ?? 0, selected?.z ?? 0);

  if (error) {
    return <main className="twin-page twin-error"><h1>{t("无法加载 FAB")}</h1><p>{error}</p><a href="/">{t("返回工作台")}</a></main>;
  }
  if (!site || !fab) {
    return <main className="twin-page twin-loading"><span>{t("正在加载 FAB…")}</span></main>;
  }
  if (!tourReady || !wafer.initialized) {
    return <main className="twin-page twin-loading"><span>{t("正在初始化 Twin Runtime…")}</span></main>;
  }

  return (
    <main className="twin-page" data-spatial-mode={ui.spatialMode ?? 'none'}>
      {site && fab && <EquipmentStatusPipeline siteId={site.siteId} fabId={fab.fabId} />}
      <header className="twin-topbar">
        <a className="twin-brand" href="/" aria-label={t("首页")}>
          <span className="twin-brand-mark"><OriginalIcon name="home" size={18} /></span>
          <div><strong>{t("300mm晶圆制造厂 (Fab)")}</strong><small>{t("先进试验线")}</small></div>
        </a>
        <div className="twin-topgroup">
          <label className="twin-mode">{t("模式:")}<select id="mode-select" value={mode} onChange={(event) => actions.setMode(event.target.value as EntryMode)}>
              <option value="visitor">{t("Visitor 导览")}</option><option value="engineer">{t("Engineer 工程师")}</option><option value="research">{t("Research 科研")}</option>
            </select>
          </label>
          <div className="twin-levels" role="group" aria-label={t("楼层")}>
            <button id="level-btn-l1" type="button" className={level === 'L1' ? 'active' : ''} onClick={actions.setL1}><OriginalIcon name="l1" /> L1</button>
            <button id="level-btn-b1" type="button" className={level === 'B1' ? 'active' : ''} onClick={actions.setB1}><OriginalIcon name="b1" /> B1</button>
            <button id="level-btn-dual" type="button" className={level === 'DUAL' ? 'active' : ''} onClick={actions.setDual}><OriginalIcon name="dual" /> Dual</button>
            <button id="level-btn-exploded" type="button" className={level === 'EXPLODED' ? 'active' : ''} onClick={actions.toggleExploded}><OriginalIcon name="exploded" />{t("爆炸解构")}</button>
          </div>
        </div>
        <div className="twin-topright">
          <div className="twin-cameras" id="camera-presets-group" role="group" aria-label={t("相机预设")}>
            <button type="button" aria-label="ISO" title="Isometric View" onClick={() => actions.setCamera('iso')}><OriginalIcon name="iso" /></button>
            <button type="button" aria-label="Top" title="Top Down Plan View" onClick={() => actions.setCamera('top')}><OriginalIcon name="top" /></button>
            <button type="button" aria-label="Litho" title="Focus Litho Amber Core" onClick={() => actions.setCamera('litho')}><OriginalIcon name="litho" /></button>
            <button type="button" aria-label="Airlock" title="Focus Cleanroom Air Shower" onClick={() => actions.setCamera('airshower')}><OriginalIcon name="airlock" /></button>
            <button id="btn-focus-patrol" type="button" aria-label={t("跟踪巡检工程师")} title={t("跟踪巡检工程师")} onClick={() => scene.current?.focusPatrol()}><OriginalIcon name="user-check" /></button>
          </div>
          <button id="btn-cinematic-tour" type="button" className={`twin-tour${tourStep !== undefined ? ' active' : ''}`} aria-pressed={tourStep !== undefined} onClick={() => { if (tourStep === undefined) startTour(); else endTour(); }}><OriginalIcon name="tour" />{tourStep === undefined ? 'Tour' : 'Stop'}</button>
          <div className="twin-layers" aria-label={t("图层")}>
            {LAYER_LABELS.filter(({ layer }) => layer !== 'airflow').map(({ layer, label }) => (
              <button id={layer === 'amhs' ? 'btn-toggle-oht' : layer === 'ceiling' ? 'btn-toggle-ceiling' : layer === 'roof' ? 'btn-toggle-roof' : layer === 'heatmap' ? 'btn-toggle-heatmap' : 'btn-toggle-piping'} type="button" key={layer} className={layers[layer] ? 'active' : ''} aria-pressed={!!layers[layer]} onClick={() => actions.toggleLayer(layer)}><OriginalIcon name={layer === 'amhs' ? 'amhs' : layer === 'ceiling' || layer === 'roof' ? 'ffu' : 'heatmap'} />{layer === 'heatmap' ? t("气流热力图") : label}</button>
            ))}
            <button id="btn-toggle-laminar" type="button" className={ui.spatialMode === 'aerodynamics' ? 'active' : ''} aria-pressed={ui.spatialMode === 'aerodynamics'} onClick={() => twinUiActions.spatialToggle(registry, 'aerodynamics')}><OriginalIcon name="airflow" /> Airflow</button>
            <button id="btn-toggle-xray" type="button" className={xrayFilter ? 'active' : ''} aria-pressed={!!xrayFilter} onClick={() => actions.applyXRayFilter(xrayFilter ? null : 'all')}><OriginalIcon name="xray" />{t("全息透视")}</button>
          </div>
          <button id="lang-toggle-btn" className="twin-language-toggle" type="button" title={language === 'zh' ? 'Switch to English' : '切换为中文'} onClick={toggleLanguage}>{language === 'zh' ? '中文' : 'English'}</button>
        </div>
      </header>

      <div className="twin-subbar" id="tour-status-subbar">
        <TwinYieldPill toolStates={toolStates} />
        <section className="twin-simulation" aria-label={t("B01 场景控制")}>
          <button id="btn-sim-play" type="button" disabled={ui.statusSource !== 'demo'} title={ui.statusSource !== 'demo' ? t("请选择本地 DEMO 状态来源") : 'Toggle Sim Clock · 1600 ms'} onClick={() => twinDemoActions.playingSet(registry, !demo.playing)} aria-pressed={ui.statusSource === 'demo' && demo.playing}>{demo.playing ? 'Ⅱ' : '▶'} <span id="lbl-sim-cycle">#{demo.cycle}</span></button>
          <select id="dt-scenario-select" aria-label="Scenario" value={demo.scenarioId} disabled={ui.statusSource !== 'demo'} onChange={(event) => actions.chooseDemoScenario(event.target.value)}>
            {YIELD_SCENARIOS.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
          </select>
        </section>
        <button type="button" className={`twin-yms-toggle${ymsOpen ? ' active' : ''}`} aria-pressed={ymsOpen} onClick={() => { actions.setYmsTab('map'); actions.setYmsOpen(!ymsOpen); }}><OriginalIcon name="wafer" />{t("YMS 晶圆图谱")}</button>
        <button id="btn-toggle-cut" type="button" className={classNames('twin-cut-toggle', { active: cutActive })} aria-pressed={cutActive} onClick={actions.toggleCut}><OriginalIcon name="cut" />{t("动态剖切")}</button>
        <button id="btn-follow-wafer" type="button" className={classNames('twin-wafer-toggle', { active: waferActive })} aria-pressed={waferActive} disabled={!wafer.commandsReady} onClick={() => { if (waferActive) wafer.closeWafer(); else wafer.startWafer(); }}><OriginalIcon name="wafer" />{t("跟随晶圆")}</button>
        <label className="twin-source"><select aria-label={t("状态来源")} value={ui.preferredStatusSource} disabled={mode === 'research'} onChange={(event) => twinUiActions.sourceSet(registry, event.target.value as 'demo' | 'sse-live')}>
          <option value="sse-live">SSE</option><option value="demo">DEMO</option>
        </select></label>
        <span className={classNames('twin-feed', { 'is-replay': mode === 'research', 'is-stale': mode !== 'research' && statusFeed?.stale })}><i />{mode === 'research' ? 'REPLAY' : ui.statusSource === 'demo' ? 'DEMO' : !statusFeed ? 'CONNECTING' : statusFeed.stale ? 'CACHE' : 'LIVE'}</span>
      </div>

      {level === 'EXPLODED' && (
        <div className="twin-explode" role="group" aria-label={t("爆炸视图")}>
          <span>EXPLODE</span>
          <input id="explode-slider" type="range" min={0} max={100} step={1} value={explodePercent} onChange={(event) => actions.changeExplode(Number(event.target.value))} aria-label={t("爆炸视图比例")} />
          <b>{explodePercent}%</b>
        </div>
      )}

      {cutActive && (
        <div className="twin-cut" role="group" aria-label={t("剖切平面")}>
          <span>CUT</span>
          <select id="cut-axis-select" value={cutAxis} onChange={(event) => actions.updateCut(event.target.value as CutAxis, cutPosition, cutInvert)} aria-label={t("剖切轴")}>
            <option value="X">X</option><option value="Y">Y</option><option value="Z">Z</option>
          </select>
          <input id="cut-slider" type="range" min={-55} max={55} step={1} value={cutPosition} onChange={(event) => actions.updateCut(cutAxis, Number(event.target.value), cutInvert)} aria-label={t("剖切位置")} />
          <b>{cutPosition.toFixed(0)} m</b>
          <label><input id="btn-cut-invert" type="checkbox" checked={cutInvert} onChange={(event) => actions.updateCut(cutAxis, cutPosition, event.target.checked)} /> Invert</label>
        </div>
      )}

      {layers.roof && <div id="roof-schematic-badge" className="twin-roof-badge">{t("屋顶与 HVAC：示意图")}</div>}

      {ui.spatialMode === 'aerodynamics' && (
        <section id="hud-panel-aero" className="twin-aero-hud" aria-label="Aerodynamics">
          <strong>{t("AERODYNAMICS · 层流与压差")}</strong>
          <span>{t("黄光区 +30 Pa → 主工艺区 +15 Pa → 灰区 0 Pa")}</span>
          <span>{selected ? `#${selected.index + 1}` : t("主工艺区")} · {pressure.pressure.toFixed(2)} Pa · ∂P/∂z {pressure.gradZ.toFixed(2)} Pa/m</span>
          <button type="button" aria-pressed={ui.aeroHeatmap} onClick={() => twinUiActions.aeroHeatmapToggle(registry)}>{t("压差热力图")}</button>
          <small>{level === 'B1' ? t("B1 隐藏洁净室粒子") : t("1500 层流粒子 · 原版示意压差场")}{t("；非实测 CFD")}</small>
        </section>
      )}

      <div className="twin-stage" id="viewport-container">
        <FabViewport
          ref={scene}
          site={site}
          fab={fab}
          toolStates={toolStates}
          onToolChange={actions.handleToolChange}
          onAmhsStatsChange={amhsBatcher.push}
          onCameraInteraction={() => { cancelTourIfRunning(); wafer.clearFollowOnCameraInteraction(); }}
          getToolStates={getToolStates}
          layers={layers}
          explodeFactor={level === 'EXPLODED' ? explodePercent / 100 : 0}
          explodeMode={exploded}
          basement={basement}
          dual={level === 'DUAL'}
        />

        {mode === 'engineer' && (
          <div className="original-hud"><TwinSidebar
            selection={selection}
            states={demo.keys}
            badgeCount={67}
            onSelect={actions.handleTwinSelection}
            onArchitecture={() => actions.setInfoDialog('architecture')}
            onDatabase={() => actions.setInfoDialog('database')}
          /></div>
        )}

        {selected && mode !== 'visitor' && selection?.kind === 'layout' && (
          <aside className="twin-inspector" aria-label={t("设备详情")}>
            <div className="twin-panel-title"><span>SELECTED TOOL · {String(selected.index + 1).padStart(3, '0')}</span><button type="button" aria-label={t("关闭设备详情")} onClick={actions.clearSelection}>×</button></div>
            <h2>{selected.vendor}</h2>
            <h3>{selected.model}</h3>
            <span className="twin-chip">{t(CATEGORY_LABELS[selected.category] ?? selected.category)}</span>
            <span className="twin-chip">{t(FAB_TOOL_STATE_META[toolStates[selected.index] ?? selected.state].label)}</span>
            <dl>
              <dt>{t("FAB 实例")}</dt><dd>{fab?.code ?? 'FAB'} / #{String(selected.index + 1).padStart(3, '0')}</dd>
              <dt>{t("实例标识")}</dt><dd>{layoutIdentities[selected.index]?.instanceId}</dd>
              <dt>{t("回放别名")}</dt><dd>{layoutIdentities[selected.index]?.machineId}{!layoutIdentities[selected.index]?.replayTarget ? t(" · 原版别名被覆盖") : ''}</dd>
              <dt>{t("尺寸 (mm)")}</dt><dd>{(selected.width * 1000).toFixed(0)} × {(selected.depth * 1000).toFixed(0)} × {(selected.height * 1000).toFixed(0)}</dd>
              <dt>{t("位置 (m)")}</dt><dd>{selected.x.toFixed(2)}, {selected.z.toFixed(2)}</dd>
              <dt>{t("来源")}</dt><dd>{t("本地布局 / OEM 目录")}</dd>
            </dl>
            <button type="button" className="twin-primary" onClick={() => scene.current?.selectTool(selected.index, true)}>{t("在场景中定位")}</button>
            <div className="twin-manual-state" role="group" aria-label={t("设备状态干预")}>
              {(['running', 'idle', 'down', 'maint'] as const).map((state) => <button type="button" key={state} disabled={ui.statusSource !== 'demo'} aria-pressed={toolStates[selected.index] === state} onClick={() => twinDemoActions.manualStateSet(registry, { index: selected.index, state })}>{state.toUpperCase()}</button>)}
            </div>
            <p className="twin-data-note">{t("状态干预限本地 DEMO；MES / SPC 为页面演示，不持久化、不发送后端制造命令。")}</p>

            {selectedMes && (
              <section className="twin-process twin-mes" aria-label="SEMI MES Job Execution">
                <div className="twin-process-head"><strong>SEMI MES · E40 / E87 / E94</strong><span className={`twin-mes-state ${selectedMes.state.toLowerCase()}`}>{selectedMes.state}</span></div>
                <div className="twin-mes-grid">
                  <div><span>CARRIER / FOUP</span><b>{selectedMes.carrierId}</b></div>
                  <div><span>ACTIVE RECIPE</span><b title={selectedMes.recipeId}>{selectedMes.recipeId}</b></div>
                  <div><span>LOT ID</span><b>{selectedMes.lotId}</b></div>
                  <div><span>WAFER SLOT</span><b>{selectedMes.waferSlot} / 25</b></div>
                </div>
                <div className="twin-mes-step"><span>Step</span><b>{selectedMes.stepName}</b></div>
                <div className="twin-mes-actions">
                  <button type="button" onClick={() => actions.runMesAction('track-in')}>Track-In</button>
                  <button type="button" onClick={() => actions.runMesAction('track-out')}>Track-Out</button>
                  <button type="button" className="hold" onClick={() => actions.runMesAction('hold')}>Hold</button>
                </div>
              </section>
            )}

            {selectedSpc && selectedTelemetry && spcPlot && (
              <section className="twin-process twin-spc" aria-label="Process Capability">
                <div className="twin-process-head"><strong>PROCESS CAPABILITY · SPC / Cpk</strong><span className={`twin-spc-state ${selectedSpc.controlStatus === 'ALARM EXCURSION' ? 'alarm' : ''}`}>CONTROL · {selectedSpc.controlStatus ?? selectedSpc.status}</span><span className={`twin-spc-state ${selectedSpc.specStatus === 'OUT OF SPEC' ? 'alarm' : ''}`}>SPEC · {selectedSpc.specStatus ?? '—'}</span></div>
                <div className="twin-spc-grid">
                  <div><span>Cp</span><b>{selectedSpc.insufficientData ? '—' : selectedSpc.cp.toFixed(2)}</b></div>
                  <div><span>Cpk</span><b className={selectedSpc.insufficientData ? '' : selectedSpc.cpk >= 1.67 ? 'good' : selectedSpc.cpk >= 1.33 ? '' : 'bad'}>{selectedSpc.insufficientData ? '—' : selectedSpc.cpk.toFixed(2)}</b></div>
                  <div><span>SIGMA</span><b>{selectedSpc.insufficientData ? '—' : `${selectedSpc.sigma.toFixed(2)} σ`}</b></div>
                </div>
                <div className={`twin-spc-rule ${selectedSpc.controlStatus === 'ALARM EXCURSION' ? 'alarm' : ''}`}><span>Implemented Nelson rules</span><b>{selectedSpc.insufficientData ? 'Insufficient data / 数据不足' : selectedSpc.rule}</b></div>
                <div className="twin-spc-sensors">
                  {selectedTelemetry.sensors.map((sensor) => (
                    <div key={sensor.name}><span>{sensor.name}</span><b>{sensor.value >= 1000 ? sensor.value.toFixed(0) : sensor.value < 0.01 ? sensor.value.toExponential(2) : sensor.value.toFixed(2)} <small>{sensor.unit}</small></b></div>
                  ))}
                </div>
                <svg className="twin-spc-spark" viewBox="0 0 240 34" role="img" aria-label="FDC control chart">
                  <line x1="0" x2="240" y1={spcPlot.uclY} y2={spcPlot.uclY} className="ucl" />
                  <line x1="0" x2="240" y1={spcPlot.meanY} y2={spcPlot.meanY} className="cl" />
                  <line x1="0" x2="240" y1={spcPlot.lclY} y2={spcPlot.lclY} className="lcl" />
                  <polyline points={spcPlot.points} className="series" />
                </svg>
                <div className="twin-spc-legend"><span>LCL −3σ</span><span>CL</span><span>UCL +3σ</span></div>
              </section>
            )}
          </aside>
        )}

        {selection && selection.kind !== 'layout' && mode !== 'visitor' && (
          <OriginalInspector
            key={`${selection.kind}-${selection.id}`}
            selection={selection}
            states={demo.keys}
            onClose={actions.clearSelection}
            onManualKey={actions.handleManualKey}
            onSelectReference={(id) => actions.handleTwinSelection({ kind: 'reference', id })}
            onSelectOem={(id) => actions.handleTwinSelection({ kind: 'oem', id })}
          />
        )}

        {mode === 'research' && (
          <TwinResearchHud scopeKey={playbackScopeKey} replayBase={replayBase} showResearchUtil={showResearchUtil} onToggleResearchUtil={actions.toggleResearchUtil} t={t} />
        )}

        {waferActive && wafer.commandsReady && (
          <TwinWaferHud
            routesReady={wafer.routesReady}
            error={wafer.error}
            onClose={wafer.closeWafer}
            onProductChange={wafer.changeWaferProduct}
            onTogglePlay={wafer.toggleWaferPlay}
            onSpeedChange={wafer.setWaferSpeed}
            onFollowChange={actions.setWaferFollow}
            onReplay={wafer.replayWafer}
          />
        )}

        {ymsOpen && (
          <TwinYmsPanel toolStates={toolStates} />
        )}
        <div id="hud-grid-badge" className="twin-grid-badge"><OriginalIcon name="ruler" />{t("网格: 6m × 6m · Subfab: -7.0m")}</div>

        <footer id="bottom-hud-footer" className="twin-bottom">
          <span className="twin-status" title={status}><i className={lifecycle === 'ready' ? 'ok' : ''} />{lifecycle === 'ready' ? 'WebGPU' : status}</span>
          <span>{fab ? `${fab.code} · ${t("独立 FAB")}` : t("FAB 视图")}</span>
          <span className="twin-footer-legend" aria-label={t("工艺分区图例")}>{[['光刻','#d99e3d'],['刻蚀','#c26b6b'],['薄膜','#d68a4a'],['Cu','#a98467'],['注入','#8b7bb5'],['扩散','#5c9b78'],['CMP/清洗','#4f9b9b'],['量测','#5b82b5'],['封装','#b06c96'],['Subfab','#4f6fa8']].map(([name,color])=><i key={name} title={name} style={{background:color}} />)}</span>
          <AmhsOhtReadout />
          {mode === 'research' ? <TwinResearchFooter scopeKey={playbackScopeKey} /> : <span>{stateCounts.running} RUN · {stateCounts.idle} IDLE · {stateCounts.down} DOWN · {stateCounts.maint} MAINT</span>}
        </footer>


        {xrayFilter && (
          <div id="hud-panel-xray" className="twin-xray" role="group" aria-label={t("X-Ray 过滤")}>
            <OriginalIcon name="eye" />
            <div className="twin-xray-content">
              <strong>{t('全息 MEP 动力管网与系统 X-Ray')} <span>{t('全息幽灵外壳生效中')}</span></strong>
              <div>{XRAY_FILTERS.map(({ filter, label }) => (
                <button id={`xray-btn-${filter}`} type="button" key={filter} className={xrayFilter === filter ? 'active' : ''} onClick={() => actions.applyXRayFilter(filter)}>{t(label)}</button>
              ))}</div>
              <p>{t('设备外壳全息半透 · 高亮流光穿透华夫板与机电管网 · 实时追踪动力介质拓扑')}</p>
            </div>
            <button type="button" className="close" onClick={() => actions.applyXRayFilter(null)} aria-label={t("关闭 X-Ray")}>×</button>
          </div>
        )}

        {tourStep !== undefined && TOUR_STOPS[tourStep] && (
          <TwinTourHud
            ref={tourHudRef}
            tourStep={tourStep}
            initialHud={tourHudSeed}
            onEnd={endTour}
            onPrev={previousTour}
            onNext={advanceTour}
          />
        )}

        {infoDialog && (
          <TwinInfoDialog
            mode={infoDialog}
            onClose={() => actions.setInfoDialog(null)}
            onSelectOem={(id) => actions.handleTwinSelection({ kind: 'oem', id })}
          />
        )}

        {onboarding && (
          <div id="onboarding-bubble" className="twin-onboarding" role="dialog" aria-modal="false" aria-label={t("首次引导")}>
            <div className="twin-onboarding-card">
              <div className="twin-onboarding-head"><span id="onboarding-step-counter">{t("首次进入 ·")}{onboardingStep + 1}/{ONBOARDING_STEPS.length}</span><button type="button" onClick={actions.dismissOnboarding} aria-label={t("跳过引导")}>×</button></div>
              <h3 id="onboarding-title">{t(ONBOARDING_STEPS[onboardingStep].title)}</h3>
              <p id="onboarding-desc">{t(ONBOARDING_STEPS[onboardingStep].body)}</p>
              <label className="twin-onboarding-dont-show"><input id="onboarding-dont-show" type="checkbox" checked={onboardingDontShow} onChange={(event) => actions.setOnboardingDontShow(event.target.checked)} /><span id="onboarding-dont-show-text">{t("不再提示")}</span></label>
              <div className="twin-onboarding-actions">
                <button type="button" onClick={actions.dismissOnboarding}>{t("跳过")}</button>
                <button id="onboarding-prev-btn" type="button" onClick={() => twinUiActions.onboardingStep(registry, onboardingStep - 1)} disabled={onboardingStep === 0}>{t("上一步")}</button>
                <button id="onboarding-next-btn" type="button" className="primary" onClick={() => { if (onboardingStep === ONBOARDING_STEPS.length - 1) actions.finishOnboarding(); else twinUiActions.onboardingStep(registry, onboardingStep + 1); }}>{onboardingStep === ONBOARDING_STEPS.length - 1 ? t("开始导览") : t("下一步")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export interface TwinPageProps {
  /** Canonical route siteId; with fabId it is the composite FAB identity. */
  siteId?: string;
  fabId?: string;
  search?: RouterSearch;
  onSearchChange?: (patch: Partial<RouterSearch>, replace?: boolean) => void;
}

export function TwinPage({ siteId, fabId, search, onSearchChange }: TwinPageProps = {}) {

  return (
    <TwinLocaleProvider>
      <TwinContent siteId={siteId} fabId={fabId} search={search} onSearchChange={onSearchChange} />
    </TwinLocaleProvider>
  );
}
