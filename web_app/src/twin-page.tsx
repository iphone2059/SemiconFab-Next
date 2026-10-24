import { OriginalIcon } from './original-icons';
import { useTwinLocale, TwinLocaleProvider } from './twin-i18n';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiClient } from './api-client';
import type { SiteDto } from './contracts';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus } from './equipment-status';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { AmhsStats, CutAxis, PickedTool, SceneLayer, XRayFilter } from './fab-scene';
import { FabViewport, type FabViewportHandle } from './fab-viewer';
import { TwinSidebar } from './twin-sidebar';
import { OriginalInspector } from './twin-inspector';
import { ORIGINAL_TWIN_UI, type TwinSelection } from './original-twin-data';
import { ResearchReplay, researchClock } from './research-replay';
import { buildWaferWaypoints, parseWaferRoutes, waferTransitPoint, type WaferProduct, type WaferRouteStep } from './wafer-route';
import { applyMesAction, buildTelemetry, computeSpc, createMesJob, type MesAction, type MesJob } from './process-control';
import { BIN_COLORS, BIN_LABELS, WM811K_DEFECT_METADATA, generateWaferMap, stdfSummary, theoreticalYieldModels, waferMetrics, type BinCode, type DefectPattern } from './wafer-map';
import { computeFabYield, DEFAULT_YIELD_INPUT, scenarioStates, YIELD_SCENARIOS } from './fab-yield';
import { createTwinUiState, projectTwinSceneState, twinUiReducer, type EntryMode, type TwinView as CameraView } from './twin-state';
import { createDemoState, DEMO_TICK_MS, demoReducer, projectReplayStates, resolveScenario, TWIN_LAYOUT_IDENTITIES } from './twin-equipment';
import { cleanroomPressureField } from './cleanroom-pressure';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from './original-tour';
const ONBOARDING_KEY = 'semicon_twin_onboarding_dismissed';
const ONBOARDING_STEPS = [
  { title: '一个单 FAB 洁净室', body: '121 台设备、双环 OHT、天花板 FFU 与 Subfab 都在同一场景中。' },
  { title: '层级与空间模式', body: '用 L1 / B1 / DUAL / Explode 切换楼层和拆解；设备卡可打开右侧检查器。' },
  { title: '开始五站导览', body: 'Tour 会依次带你查看光刻、刻蚀、OHT 和 Subfab。按 Esc 可退出。' },
];

const CATEGORY_LABELS: Record<string, string> = {
  lithography: '光刻',
  resist_track: '涂胶显影',
  dry_etch: '干法刻蚀',
  thin_film_deposition: '薄膜沉积',
  cmp: '化学机械抛光',
  wet_clean: '湿法清洗',
  ion_implantation: '离子注入',
  thermal_processing: '热处理',
  metrology: '量测',
  inspection: '检测',
  packaging: '封装',
  test: '测试',
  other: '其他设备',
};

const CATEGORY_BAYS: Record<string, [string, string]> = {
  lithography: ['光刻曝光区', 'Lithography Bay'], resist_track: ['涂胶显影区', 'Track Bay'], dry_etch: ['等离子刻蚀区', 'Etch Bay'],
  thin_film_deposition: ['薄膜沉积区', 'Deposition Bay'], cmp: ['CMP 研磨区', 'CMP Bay'], wet_clean: ['湿法清洗区', 'Wet Clean Bay'],
  ion_implantation: ['离子注入区', 'Implant Bay'], thermal_processing: ['扩散/热处理区', 'Diffusion Bay'], metrology: ['量测区', 'Metrology Bay'],
  inspection: ['检测区', 'Inspection Bay'], packaging: ['先进封装区', 'Packaging Bay'], test: ['测试区', 'Test Bay'], other: ['其他设备区', 'Other Bay'],
};

const LAYER_LABELS: { layer: SceneLayer; label: string }[] = [
  { layer: 'amhs', label: 'AMHS' },
  { layer: 'ceiling', label: 'FFU' },
  { layer: 'roof', label: 'Roof/HVAC' },
  { layer: 'subfab', label: 'Subfab' },
  { layer: 'heatmap', label: 'Heatmap' },
  { layer: 'airflow', label: 'Airflow' },
];
const XRAY_FILTERS: { filter: XRayFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'upw', label: 'UPW' },
  { filter: 'gas', label: 'Gas' },
  { filter: 'vac', label: 'Vac' },
  { filter: 'exhaust', label: 'Exhaust' },
  { filter: 'amhs', label: 'AMHS' },
];

function TwinContent() {
  const { t, language, toggleLanguage } = useTwinLocale();
  const scene = useRef<FabViewportHandle>(null);
  const [ui, dispatch] = useReducer(twinUiReducer, undefined, () => {
    const requested = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('mode');
    return createTwinUiState(requested === 'visitor' || requested === 'research' ? requested : 'engineer');
  });
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
  const waferActive = ui.wafer.active;
  const waferPlaying = ui.wafer.playing;
  const waferSpeed = ui.wafer.speed;
  const researchTime = ui.research.timeSec;
  const researchPlaying = ui.research.playing;
  const researchSpeed = ui.research.speed;
  const [replayBase, setReplayBase] = useState<readonly FabToolState[]>(() => [...FAB_TOOL_STATES]);
  const setMode = (value: EntryMode) => {
    if (value === 'research' && mode !== 'research') setReplayBase([...toolStates]);
    dispatch({ type: 'mode/set', mode: value });
  };
  const setWaferPlaying = (playing: boolean) => dispatch({ type: 'wafer/play', playing });
  const setWaferSpeed = (speed: 1 | 4 | 16) => dispatch({ type: 'wafer/speed', speed });
  const setResearchPlaying = (playing: boolean) => dispatch({ type: 'research/play', playing });
  const setResearchTime = (timeSec: number) => dispatch({ type: 'research/seek', timeSec });
  const setResearchSpeed = (speed: 1 | 10 | 100 | 500) => dispatch({ type: 'research/speed', speed });
  const [site, setSite] = useState<SiteDto>();
  const [error, setError] = useState<string>();
  const [liveToolStates, setLiveToolStates] = useState<FabToolState[]>(() => [...FAB_TOOL_STATES]);
  const [demo, dispatchDemo] = useReducer(demoReducer, undefined, () => demoReducer(createDemoState(42), { type: 'scenario', scenario: YIELD_SCENARIOS[0] }));
  const [statusFeed, setStatusFeed] = useState<{ updatedAt: string; stale: boolean }>();
  const [layerPreferences, setLayers] = useState<Record<SceneLayer, boolean>>({
    amhs: true,
    ceiling: false,
    roof: false,
    subfab: false,
    heatmap: false,
    airflow: false,
    xray: false,
  });
  const projected = projectTwinSceneState(ui);
  const layers = useMemo(() => ({ ...layerPreferences, airflow: projected.airflow, heatmap: projected.heatmap, xray: projected.xray !== null }),
    [layerPreferences, projected.airflow, projected.heatmap, projected.xray]);
  const [selected, setSelected] = useState<PickedTool>();
  const [selection, setSelection] = useState<TwinSelection>();
  const [mesJobs, setMesJobs] = useState<Record<number, MesJob>>({});
  const [ymsOpen, setYmsOpen] = useState(false);
  const [ymsTab, setYmsTab] = useState<'map' | 'yield'>('map');
  const [waferPattern, setWaferPattern] = useState<DefectPattern>('clean');
  const [waferSeed, setWaferSeed] = useState(811);
  const [hoverDie, setHoverDie] = useState<{ r: number; c: number; bin: BinCode }>();
  const [dieArea, setDieArea] = useState(100);
  const [defectD0, setDefectD0] = useState(0.15);
  const [clusterAlpha, setClusterAlpha] = useState(3);
  const [yieldInput, setYieldInput] = useState(DEFAULT_YIELD_INPUT);
  const [yieldScenario, setYieldScenario] = useState('live');
  const [stdfCopied, setStdfCopied] = useState(false);
  const [status, setStatus] = useState(t("准备 WebGPU 视图…"));
  const appliedCameraView = useRef<CameraView | undefined>(undefined);
  const [amhs, setAmhs] = useState<AmhsStats>();
  const [railOpen] = useState(true);
  const [infoDialog, setInfoDialog] = useState<'architecture' | 'database' | null>(null);
  const [research, setResearch] = useState<ResearchReplay>();
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [showResearchUtil, setShowResearchUtil] = useState(true);
  const [waferProduct, setWaferProduct] = useState<WaferProduct>('A');
  const [waferRoutes, setWaferRoutes] = useState<Record<WaferProduct, WaferRouteStep[]>>();
  const [waferIndex, setWaferIndex] = useState(0);
  const [waferFollow, setWaferFollow] = useState(true);
  const [waferError, setWaferError] = useState('');
  const waferIndexRef = useRef(0);
  const waferProgressRef = useRef(0);
  const waferTrailRef = useRef<[number, number, number][]>([]);
  const suppressToolSelectionRef = useRef(false);

  useEffect(() => { scene.current?.setLanguage(language); }, [language, status]);

  useEffect(() => {
    const controller = new AbortController();
    void new ApiClient().sites(controller.signal)
      .then((sites) => {
        if (controller.signal.aborted) return;
        const wanted = new URL(location.href).searchParams.get('siteId');
        const next = wanted ? sites.find((value) => value.siteId === wanted) : sites[0];
        if (!next) throw new Error(wanted ? t("指定的 FAB 站点不存在：{0}", [wanted]) : t("没有可用的 FAB 站点"));
        if (next.fabs.length !== 1) throw new Error(t("当前产品必须只有一个 FAB"));
        setSite(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("FAB 数据加载失败"));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!site) return;
    const api = new ApiClient();
    const controller = new AbortController();
    const applySnapshot = createOrderedEquipmentStatusConsumer(
      site.siteId,
      FAB_LAYOUT.length,
      (snapshot) => {
        const next = FAB_LAYOUT.map((_, index): FabToolState => {
          const value = snapshot.tools[index]?.state;
          return value === 'running' || value === 'idle' || value === 'down' || value === 'maint' ? value : 'idle';
        });
        setStatusFeed({ updatedAt: snapshot.generatedAt, stale: false });
        // SSE only updates its own cache. The selected authority derives rendered states.
        setLiveToolStates(next);
      },
      () => setStatusFeed((current) => current ? { ...current, stale: true } : current),
    );
    void api.equipmentStatus(site.siteId, controller.signal)
      .then((snapshot) => { if (!controller.signal.aborted) applySnapshot(snapshot); })
      .catch(() => { if (!controller.signal.aborted) setStatusFeed((current) => current ? { ...current, stale: true } : current); });
    const source = new EventSource(`/api/v1/sites/${encodeURIComponent(site.siteId)}/equipment-status/stream`);
    watchEquipmentStatus(source, site.siteId, applySnapshot,
      () => setStatusFeed((current) => current && !current.stale ? { ...current, stale: true } : current), controller.signal);
    return () => {
      controller.abort();
    };
  }, [site]);

  useEffect(() => {
    if (ui.statusSource !== 'demo' || !demo.playing) return;
    const timer = window.setInterval(() => dispatchDemo({ type: 'tick' }), DEMO_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ui.statusSource, demo.playing]);

  useEffect(() => {
    if (site) document.title = `${site.code} / FAB-01 · 3D FAB`;
  }, [site]);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('mode', mode);
    history.replaceState({}, '', url);
  }, [mode]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    // Restore material state before changing levels, then apply the single active mode.
    scene.current?.setXRayFilter(null);
    scene.current?.setBasement(basement);
    scene.current?.setDual(level === 'DUAL');
    scene.current?.setExplodeFactor(exploded ? explodePercent / 100 : 0);
    scene.current?.setCutPlane(cutActive, cutAxis, cutPosition, cutInvert);
    scene.current?.setXRayFilter(xrayFilter);
  }, [status, basement, level, exploded, explodePercent, cutActive, cutAxis, cutPosition, cutInvert, xrayFilter]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    // A rebuilt GPU retains the camera object and its user pose. Fresh mounts
    // still apply the requested preset; explicit preset changes always apply.
    if (status.startsWith('WebGPU ·') || appliedCameraView.current !== view) scene.current?.setView(view);
    appliedCameraView.current = view;
  }, [status, view]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    if (!ui.tour.active) { scene.current?.setTour(false); return; }
    scene.current?.setTour(true);
    const stop = TOUR_STOPS[ui.tour.waypoint];
    scene.current?.setCameraPose(stop.position, stop.target, stop.durationMs);
  }, [status, ui.tour.active, ui.tour.waypoint]);

  useEffect(() => {
    if (mode !== 'research' || research) return;
    const controller = new AbortController();
    setResearchLoading(true);
    setResearchError('');
    void fetch('/twin/events-t1-fifo.jsonl', { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((text) => {
        if (controller.signal.aborted) return;
        const replay = ResearchReplay.parse(text);
        setResearch(replay);
        setResearchTime(Math.min(3600, replay.durationSec));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setResearchError(reason instanceof Error ? reason.message : t("回放数据加载失败"));
      })
      .finally(() => { if (!controller.signal.aborted) setResearchLoading(false); });
    return () => controller.abort();
  }, [mode, research]);

  useEffect(() => {
    if (!researchPlaying || !research) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = ((now - last) / 1000) * researchSpeed;
      last = now;
      dispatch({ type: 'research/advance', deltaSec: elapsed, durationSec: research.durationSec });
    }, 100);
    return () => window.clearInterval(timer);
  }, [researchPlaying, research, researchSpeed]);

  const researchSnapshot = useMemo(() => research?.snapshot(researchTime), [research, researchTime]);
  const replayProjection = useMemo(() => researchSnapshot ? projectReplayStates(researchSnapshot, replayBase) : undefined, [researchSnapshot, replayBase]);
  const toolStates = ui.statusSource === 'research-replay' ? replayProjection?.states ?? replayBase
    : ui.statusSource === 'demo' ? demo.states : liveToolStates;

  useEffect(() => {
    if (!waferActive || waferRoutes) return;
    const controller = new AbortController();
    setWaferError('');
    void fetch('/twin/routes.json', { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<unknown>; })
      .then((value) => { if (!controller.signal.aborted) setWaferRoutes(parseWaferRoutes(value)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setWaferError(reason instanceof Error ? reason.message : t("路线加载失败")); });
    return () => controller.abort();
  }, [waferActive, waferRoutes]);

  const waferWaypoints = useMemo(() => waferRoutes ? buildWaferWaypoints(waferRoutes[waferProduct]) : [], [waferRoutes, waferProduct]);
  const waferPoint = waferWaypoints[waferIndex];
  const selectedTelemetry = useMemo(() => selected ? buildTelemetry(FAB_LAYOUT[selected.index], selected.index) : undefined, [selected?.index]);
  const selectedSpc = useMemo(() => selectedTelemetry ? computeSpc(selectedTelemetry.history, selectedTelemetry.sensors[0], toolStates[selected?.index ?? 0] === 'down') : undefined, [selectedTelemetry, toolStates, selected?.index]);
  const selectedMes = selected ? mesJobs[selected.index] ?? createMesJob(FAB_LAYOUT[selected.index], selected.index) : undefined;
  const waferDies = useMemo(() => generateWaferMap(waferPattern, waferSeed), [waferPattern, waferSeed]);
  const waferAnalytics = useMemo(() => waferMetrics(waferDies), [waferDies]);
  const yieldModels = useMemo(() => theoreticalYieldModels(dieArea, defectD0, clusterAlpha), [dieArea, defectD0, clusterAlpha]);
  const stdf = useMemo(() => stdfSummary(waferDies, waferPattern), [waferDies, waferPattern]);
  const yieldStates = useMemo(() => {
    if (yieldScenario === 'live') return toolStates;
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === yieldScenario);
    return scenario ? scenarioStates(scenario) : toolStates;
  }, [toolStates, yieldScenario]);
  const yieldUnresolved = useMemo(() => {
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === yieldScenario);
    return scenario ? resolveScenario(scenario).unresolvedIds : [];
  }, [yieldScenario]);
  const fabYield = useMemo(() => computeFabYield(yieldStates, yieldInput), [yieldStates, yieldInput]);
  const spcPlot = selectedTelemetry ? (() => {
    const values = selectedTelemetry.history;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = high - low || 1;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)) || 0.001;
    return {
      points: values.map((value, index) => `${(index / (values.length - 1)) * 240},${30 - ((value - low) / range) * 26 - 2}`).join(' '),
      meanY: 30 - ((mean - low) / range) * 26 - 2,
      uclY: 30 - ((mean + 3 * std - low) / range) * 26 - 2,
      lclY: 30 - ((mean - 3 * std - low) / range) * 26 - 2,
    };
  })() : undefined;

  useEffect(() => {
    if (!waferActive || !waferPoint || waferPlaying) {
      if (!waferActive) {
        scene.current?.setWaferPoint(0, 0, 0, false, false);
        scene.current?.setWaferTrail([]);
      }
      return;
    }
    scene.current?.setWaferPoint(waferPoint.x, waferPoint.y, waferPoint.z, true, waferFollow);
  }, [waferActive, waferPoint, waferFollow, waferPlaying]);

  useEffect(() => {
    if (!waferPlaying || !waferActive || waferWaypoints.length === 0) return;
    let frame = 0;
    let last = performance.now();
    let running = true;
    const tick = (now: number) => {
      if (!running) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const index = waferIndexRef.current;
      waferProgressRef.current = Math.min(1, waferProgressRef.current + dt / (2 / waferSpeed));
      const progress = waferProgressRef.current;
      const point = waferTransitPoint(waferWaypoints, index, progress);
      scene.current?.setWaferPoint(point.x, point.y, point.z, true, waferFollow);
      const trail = waferTrailRef.current;
      const previous = trail[trail.length - 1];
      if (!previous || Math.hypot(point.x - previous[0], point.z - previous[2]) > 0.25) {
        trail.push([point.x, point.y, point.z]);
        if (trail.length > 30) trail.shift();
        scene.current?.setWaferTrail(trail);
      }
      if (progress >= 1) {
        if (index >= waferWaypoints.length - 1) {
          setWaferPlaying(false);
          return;
        }
        waferIndexRef.current = index + 1;
        waferProgressRef.current = 0;
        setWaferIndex(index + 1);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(frame); };
  }, [waferPlaying, waferActive, waferWaypoints, waferSpeed, waferFollow]);

  useEffect(() => {
    try {
      if (localStorage.getItem(ONBOARDING_KEY) !== '1') dispatch({ type: 'onboarding/open' });
    } catch {
      // Storage may be blocked; the page still works without onboarding memory.
    }
  }, []);

  useEffect(() => {
    if (tourStep === undefined) return;
    const stop = TOUR_STOPS[tourStep];
    const timer = window.setTimeout(() => advanceTour(), stop.durationMs + stop.holdMs);
    return () => window.clearTimeout(timer);
  }, [tourStep]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape') {
        dispatch({ type: 'escape' });
        scene.current?.clearSelection();
        setSelected(undefined);
        setSelection(undefined);
        setYmsOpen(false);
        setInfoDialog(null);
        return;
      }
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === '1') setCamera('iso');
      if (event.key === '2') setCamera('top');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fab = site?.fabs[0];
  const stateCounts = useMemo(() => {
    const counts = { running: 0, idle: 0, down: 0, maint: 0 };
    for (const state of toolStates) counts[state] += 1;
    return counts;
  }, [toolStates]);
  const utilization = (stateCounts.running / FAB_LAYOUT.length) * 100;
  const pressure = cleanroomPressureField(selected?.x ?? 0, selected?.z ?? 0);

  function setCamera(next: CameraView): void {
    dispatch({ type: 'view/set', view: next });
    // Repeating the active preset still re-centres a manually moved camera.
    if (next === view) scene.current?.setView(next);
  }
  function toggleLayer(layer: SceneLayer): void {
    if (layer === 'airflow') { dispatch({ type: 'spatial/toggle', mode: 'aerodynamics' }); return; }
    if (layer === 'heatmap') { dispatch({ type: 'aero/heatmap' }); return; }
    if (layer === 'xray') { dispatch({ type: 'spatial/toggle', mode: 'xray' }); return; }
    setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }
  function applyXRayFilter(filter: XRayFilter | null): void { dispatch({ type: 'xray/set', filter }); }
  function toggleCut(): void { dispatch({ type: 'spatial/toggle', mode: 'cut' }); }
  function updateCut(axis: CutAxis, position: number, invert: boolean): void {
    dispatch({ type: 'cut/set', axis, positionM: position, invert });
  }
  function setL1(): void { dispatch({ type: 'level/set', level: 'L1' }); }
  function setB1(): void { dispatch({ type: 'level/set', level: level === 'B1' ? 'L1' : 'B1' }); }
  function setDual(): void { dispatch({ type: 'level/set', level: level === 'DUAL' ? 'L1' : 'DUAL' }); }
  function toggleExploded(): void { dispatch({ type: 'spatial/toggle', mode: 'exploded' }); }
  function changeExplode(percent: number): void { dispatch({ type: 'explode/set', percent }); }
  function applyTourStep(index: number): void {
    const stop = TOUR_STOPS[index];
    if (stop) dispatch({ type: 'tour/step', waypoint: index, level: stop.level, view: 'iso' });
  }
  function chooseYieldScenario(id: string): void {
    setYieldScenario(id);
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === id);
    setYieldInput(scenario ? { purity: scenario.purity, health: scenario.health, lagTime: scenario.lagTime } : DEFAULT_YIELD_INPUT);
  }
  function handleTwinSelection(next: TwinSelection): void {
    setSelection(next);
    if (next.kind === 'reference') {
      const row = ORIGINAL_TWIN_UI.equipment.find((item) => item.id === next.id);
      const catalogIndex = FAB_LAYOUT.findIndex((tool) => tool.originalKind === 'catalog' && tool.recordId === next.id);
      setSelected(undefined);
      if (catalogIndex >= 0) { suppressToolSelectionRef.current = true; scene.current?.selectTool(catalogIndex, false); window.setTimeout(() => { suppressToolSelectionRef.current = false; }, 0); }
      else scene.current?.clearSelection();
      if (row?.level === 'B1') { dispatch({ type: 'level/set', level: 'B1' }); scene.current?.setDual(false); scene.current?.setBasement(true); }
    } else if (next.kind === 'oem') {
      setSelected(undefined);
      scene.current?.clearSelection();
    }
  }
  function handleToolChange(tool?: PickedTool): void {
    setSelected(tool);
    if (suppressToolSelectionRef.current) { suppressToolSelectionRef.current = false; return; }
    if (tool && selection?.kind === 'reference' && FAB_LAYOUT[tool.index]?.recordId === selection.id) return;
    if (tool) setSelection({ kind: 'layout', index: tool.index });
    else if (selection?.kind === 'layout') setSelection(undefined);
  }
  function handleManualKey(key: string, state: FabToolState): void {
    dispatchDemo({ type: 'manual-key', key, state });
  }
  function runMesAction(action: MesAction): void {
    if (!selected) return;
    const index = selected.index;
    setMesJobs((current) => ({
      ...current,
      [index]: applyMesAction(current[index] ?? createMesJob(FAB_LAYOUT[index], index), action),
    }));
  }
  function chooseDemoScenario(id: string): void {
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === id);
    if (!scenario) return;
    dispatch({ type: 'source/set', source: 'demo' });
    dispatchDemo({ type: 'scenario', scenario });
    setYieldScenario('live');
    setYieldInput({ purity: scenario.purity, health: scenario.health, lagTime: scenario.lagTime });
  }
  function clearWaferTrail(): void {
    waferIndexRef.current = 0;
    waferProgressRef.current = 0;
    waferTrailRef.current = [];
    scene.current?.setWaferTrail([]);
  }
  function startWafer(): void {
    dispatch({ type: 'wafer/open' });
    setWaferIndex(0);
    setWaferPlaying(false);
    setWaferProduct('A');
    clearWaferTrail();
  }
  function closeWafer(): void {
    dispatch({ type: 'wafer/close' });
    setWaferPlaying(false);
    scene.current?.setWaferPoint(0, 0, 0, false, false);
    scene.current?.setWaferTrail([]);
    scene.current?.setView('iso');
  }
  function replayWafer(): void {
    clearWaferTrail();
    setWaferIndex(0);
    setWaferPlaying(true);
  }
  function changeWaferProduct(product: WaferProduct): void {
    setWaferProduct(product);
    setWaferIndex(0);
    setWaferPlaying(false);
    clearWaferTrail();
  }
  function seekWafer(index: number): void {
    setWaferPlaying(false);
    waferIndexRef.current = index;
    waferProgressRef.current = 0;
    setWaferIndex(index);
  }
  function startTour(): void {
    applyTourStep(0);
  }
  function endTour(): void {
    dispatch({ type: 'tour/stop' });
  }
  function advanceTour(): void {
    if (tourStep === undefined) return;
    if (tourStep >= TOUR_STOPS.length - 1) endTour();
    else applyTourStep(tourStep + 1);
  }
  function previousTour(): void {
    if (tourStep === undefined) return;
    applyTourStep(Math.max(0, tourStep - 1));
  }
  function dismissOnboarding(): void {
    dispatch({ type: 'onboarding/close' });
    try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* ignore storage denial */ }
  }
  function finishOnboarding(): void {
    dismissOnboarding();
    startTour();
  }

  if (error) {
    return <main className="twin-page twin-error"><h1>{t("无法加载 FAB")}</h1><p>{error}</p><a href="/">{t("返回工作台")}</a></main>;
  }
  if (!site || !fab) {
    return <main className="twin-page twin-loading"><span>{t("正在加载 FAB…")}</span></main>;
  }

  return (
    <main className="twin-page" data-spatial-mode={ui.spatialMode ?? 'none'}>
      <header className="twin-topbar">
        <a className="twin-brand" href="/" aria-label={t("首页")}>
          <span className="twin-brand-mark"><OriginalIcon name="home" size={18} /></span>
          <div><strong>{t("300mm晶圆制造厂 (Fab)")}</strong><small>{t("先进试验线")}</small></div>
        </a>
        <div className="twin-topgroup">
          <label className="twin-mode">{t("模式:")}<select id="mode-select" value={mode} onChange={(event) => setMode(event.target.value as EntryMode)}>
              <option value="visitor">{t("Visitor 导览")}</option><option value="engineer">{t("Engineer 工程师")}</option><option value="research">{t("Research 科研")}</option>
            </select>
          </label>
          <div className="twin-levels" role="group" aria-label={t("楼层")}>
            <button id="level-btn-l1" type="button" className={level === 'L1' ? 'active' : ''} onClick={setL1}><OriginalIcon name="l1" /> L1</button>
            <button id="level-btn-b1" type="button" className={level === 'B1' ? 'active' : ''} onClick={setB1}><OriginalIcon name="b1" /> B1</button>
            <button id="level-btn-dual" type="button" className={level === 'DUAL' ? 'active' : ''} onClick={setDual}><OriginalIcon name="dual" /> Dual</button>
            <button id="level-btn-exploded" type="button" className={level === 'EXPLODED' ? 'active' : ''} onClick={toggleExploded}><OriginalIcon name="exploded" />{t("爆炸解构")}</button>
          </div>
        </div>
        <div className="twin-topright">
          <div className="twin-cameras" id="camera-presets-group" role="group" aria-label={t("相机预设")}>
            <button type="button" aria-label="ISO" title="Isometric View" onClick={() => setCamera('iso')}><OriginalIcon name="iso" /></button>
            <button type="button" aria-label="Top" title="Top Down Plan View" onClick={() => setCamera('top')}><OriginalIcon name="top" /></button>
            <button type="button" aria-label="Litho" title="Focus Litho Amber Core" onClick={() => setCamera('litho')}><OriginalIcon name="litho" /></button>
            <button type="button" aria-label="Airlock" title="Focus Cleanroom Air Shower" onClick={() => setCamera('airshower')}><OriginalIcon name="airlock" /></button>
            <button id="btn-focus-patrol" type="button" aria-label={t("跟踪巡检工程师")} title={t("跟踪巡检工程师")} onClick={() => scene.current?.focusPatrol()}><OriginalIcon name="user-check" /></button>
          </div>
          <button id="btn-cinematic-tour" type="button" className={`twin-tour${tourStep !== undefined ? ' active' : ''}`} aria-pressed={tourStep !== undefined} onClick={() => { if (tourStep === undefined) startTour(); else endTour(); }}><OriginalIcon name="tour" />{tourStep === undefined ? 'Tour' : 'Stop'}</button>
          <div className="twin-layers" aria-label={t("图层")}>
            {LAYER_LABELS.filter(({ layer }) => layer !== 'airflow').map(({ layer, label }) => (
              <button id={layer === 'amhs' ? 'btn-toggle-oht' : layer === 'ceiling' ? 'btn-toggle-ceiling' : layer === 'roof' ? 'btn-toggle-roof' : layer === 'heatmap' ? 'btn-toggle-heatmap' : 'btn-toggle-piping'} type="button" key={layer} className={layers[layer] ? 'active' : ''} aria-pressed={!!layers[layer]} onClick={() => toggleLayer(layer)}><OriginalIcon name={layer === 'amhs' ? 'amhs' : layer === 'ceiling' || layer === 'roof' ? 'ffu' : 'heatmap'} />{layer === 'heatmap' ? t("气流热力图") : label}</button>
            ))}
            <button id="btn-toggle-laminar" type="button" className={ui.spatialMode === 'aerodynamics' ? 'active' : ''} aria-pressed={ui.spatialMode === 'aerodynamics'} onClick={() => dispatch({ type: 'spatial/toggle', mode: 'aerodynamics' })}><OriginalIcon name="airflow" /> Airflow</button>
            <button id="btn-toggle-xray" type="button" className={xrayFilter ? 'active' : ''} aria-pressed={!!xrayFilter} onClick={() => applyXRayFilter(xrayFilter ? null : 'all')}><OriginalIcon name="xray" />{t("全息透视")}</button>
          </div>
          <button id="lang-toggle-btn" className="twin-language-toggle" type="button" title={language === 'zh' ? 'Switch to English' : '切换为中文'} onClick={toggleLanguage}>{language === 'zh' ? '中文' : 'English'}</button>
        </div>
      </header>

      <div className="twin-subbar" id="tour-status-subbar">
        <button id="header-yield-val" className="twin-yield-pill" type="button" title="Cascading Yield Model" onClick={() => { setYmsOpen(true); setYmsTab('yield'); }}>{(fabYield.totalYield * 100).toFixed(2)}%⌄</button>
        <span id="header-wpm-val" className="twin-throughput">{fabYield.wpm.toLocaleString('en-US')}<small>{t("片/月")}</small></span>
        <section className="twin-simulation" aria-label={t("B01 场景控制")}>
          <button id="btn-sim-play" type="button" disabled={ui.statusSource !== 'demo'} title={ui.statusSource !== 'demo' ? t("请选择本地 DEMO 状态来源") : 'Toggle Sim Clock · 1600 ms'} onClick={() => dispatchDemo({ type: 'play', playing: !demo.playing })} aria-pressed={ui.statusSource === 'demo' && demo.playing}>{demo.playing ? 'Ⅱ' : '▶'} <span id="lbl-sim-cycle">#{demo.cycle}</span></button>
          <select id="dt-scenario-select" aria-label="Scenario" value={demo.scenarioId} disabled={ui.statusSource !== 'demo'} onChange={(event) => chooseDemoScenario(event.target.value)}>
            {YIELD_SCENARIOS.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
          </select>
        </section>
        <button type="button" className={`twin-yms-toggle${ymsOpen ? ' active' : ''}`} aria-pressed={ymsOpen} onClick={() => { setYmsTab('map'); setYmsOpen((open) => !open); }}><OriginalIcon name="wafer" />{t("YMS 晶圆图谱")}</button>
        <button id="btn-toggle-cut" type="button" className={`twin-cut-toggle${cutActive ? ' active' : ''}`} aria-pressed={cutActive} onClick={toggleCut}><OriginalIcon name="cut" />{t("动态剖切")}</button>
        <button id="btn-follow-wafer" type="button" className={`twin-wafer-toggle${waferActive ? ' active' : ''}`} aria-pressed={waferActive} onClick={() => { if (waferActive) closeWafer(); else startWafer(); }}><OriginalIcon name="wafer" />{t("跟随晶圆")}</button>
        <label className="twin-source"><select aria-label={t("状态来源")} value={ui.preferredStatusSource} disabled={mode === 'research'} onChange={(event) => dispatch({ type: 'source/set', source: event.target.value as 'demo' | 'sse-live' })}>
          <option value="sse-live">SSE</option><option value="demo">DEMO</option>
        </select></label>
        <span className={`twin-feed${mode === 'research' ? ' is-replay' : statusFeed?.stale ? ' is-stale' : ''}`}><i />{mode === 'research' ? 'REPLAY' : ui.statusSource === 'demo' ? 'DEMO' : !statusFeed ? 'CONNECTING' : statusFeed.stale ? 'CACHE' : 'LIVE'}</span>
      </div>

      {level === 'EXPLODED' && (
        <div className="twin-explode" role="group" aria-label={t("爆炸视图")}>
          <span>EXPLODE</span>
          <input id="explode-slider" type="range" min={0} max={100} step={1} value={explodePercent} onChange={(event) => changeExplode(Number(event.target.value))} aria-label={t("爆炸视图比例")} />
          <b>{explodePercent}%</b>
        </div>
      )}

      {cutActive && (
        <div className="twin-cut" role="group" aria-label={t("剖切平面")}>
          <span>CUT</span>
          <select id="cut-axis-select" value={cutAxis} onChange={(event) => updateCut(event.target.value as CutAxis, cutPosition, cutInvert)} aria-label={t("剖切轴")}>
            <option value="X">X</option><option value="Y">Y</option><option value="Z">Z</option>
          </select>
          <input id="cut-slider" type="range" min={-55} max={55} step={1} value={cutPosition} onChange={(event) => updateCut(cutAxis, Number(event.target.value), cutInvert)} aria-label={t("剖切位置")} />
          <b>{cutPosition.toFixed(0)} m</b>
          <label><input id="btn-cut-invert" type="checkbox" checked={cutInvert} onChange={(event) => updateCut(cutAxis, cutPosition, event.target.checked)} /> Invert</label>
        </div>
      )}

      {ui.spatialMode === 'aerodynamics' && (
        <section id="hud-panel-aero" className="twin-aero-hud" aria-label="Aerodynamics">
          <strong>{t("AERODYNAMICS · 层流与压差")}</strong>
          <span>{t("黄光区 +30 Pa → 主工艺区 +15 Pa → 灰区 0 Pa")}</span>
          <span>{selected ? `#${selected.index + 1}` : t("主工艺区")} · {pressure.pressure.toFixed(2)} Pa · ∂P/∂z {pressure.gradZ.toFixed(2)} Pa/m</span>
          <button type="button" aria-pressed={ui.aeroHeatmap} onClick={() => dispatch({ type: 'aero/heatmap' })}>{t("压差热力图")}</button>
          <small>{level === 'B1' ? t("B1 隐藏洁净室粒子") : t("1500 层流粒子 · 原版示意压差场")}{t("；非实测 CFD")}</small>
        </section>
      )}

      <div className="twin-stage" id="viewport-container">
        <FabViewport
          ref={scene}
          site={site}
          fab={fab}
          toolStates={toolStates}
          onToolChange={handleToolChange}
          onStatusChange={setStatus}
          onAmhsStatsChange={setAmhs}
          layers={layers}
          explodeFactor={level === 'EXPLODED' ? explodePercent / 100 : 0}
          basement={basement}
          dual={level === 'DUAL'}
        />

        {railOpen && mode === 'engineer' && (
          <div className="original-hud"><TwinSidebar
            selection={selection}
            states={demo.keys}
            badgeCount={67}
            onSelect={handleTwinSelection}
            onArchitecture={() => setInfoDialog('architecture')}
            onDatabase={() => setInfoDialog('database')}
          /></div>
        )}

        {selected && mode !== 'visitor' && selection?.kind === 'layout' && (
          <aside className="twin-inspector" aria-label={t("设备详情")}>
            <div className="twin-panel-title"><span>SELECTED TOOL · {String(selected.index + 1).padStart(3, '0')}</span><button type="button" aria-label={t("关闭设备详情")} onClick={() => { scene.current?.clearSelection(); setSelected(undefined); setSelection(undefined); }}>×</button></div>
            <h2>{selected.vendor}</h2>
            <h3>{selected.model}</h3>
            <span className="twin-chip">{t(CATEGORY_LABELS[selected.category] ?? selected.category)}</span>
            <span className="twin-chip">{t(FAB_TOOL_STATE_META[toolStates[selected.index] ?? selected.state].label)}</span>
            <dl>
              <dt>{t("FAB 实例")}</dt><dd>FAB-01 / #{String(selected.index + 1).padStart(3, '0')}</dd>
              <dt>{t("实例标识")}</dt><dd>{TWIN_LAYOUT_IDENTITIES[selected.index]?.instanceId}</dd>
              <dt>{t("回放别名")}</dt><dd>{TWIN_LAYOUT_IDENTITIES[selected.index]?.machineId}{!TWIN_LAYOUT_IDENTITIES[selected.index]?.replayTarget ? t(" · 原版别名被覆盖") : ''}</dd>
              <dt>{t("尺寸 (mm)")}</dt><dd>{(selected.width * 1000).toFixed(0)} × {(selected.depth * 1000).toFixed(0)} × {(selected.height * 1000).toFixed(0)}</dd>
              <dt>{t("位置 (m)")}</dt><dd>{selected.x.toFixed(2)}, {selected.z.toFixed(2)}</dd>
              <dt>{t("来源")}</dt><dd>{t("本地布局 / OEM 目录")}</dd>
            </dl>
            <button type="button" className="twin-primary" onClick={() => scene.current?.selectTool(selected.index, true)}>{t("在场景中定位")}</button>
            <div className="twin-manual-state" role="group" aria-label={t("设备状态干预")}>
              {(['running', 'idle', 'down', 'maint'] as const).map((state) => <button type="button" key={state} disabled={ui.statusSource !== 'demo'} aria-pressed={toolStates[selected.index] === state} onClick={() => dispatchDemo({ type: 'manual', index: selected.index, state })}>{state.toUpperCase()}</button>)}
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
                  <button type="button" onClick={() => runMesAction('track-in')}>Track-In</button>
                  <button type="button" onClick={() => runMesAction('track-out')}>Track-Out</button>
                  <button type="button" className="hold" onClick={() => runMesAction('hold')}>Hold</button>
                </div>
              </section>
            )}

            {selectedSpc && selectedTelemetry && spcPlot && (
              <section className="twin-process twin-spc" aria-label="Process Capability">
                <div className="twin-process-head"><strong>PROCESS CAPABILITY · SPC / Cpk</strong><span className={`twin-spc-state ${selectedSpc.status.startsWith('ALARM') ? 'alarm' : 'ok'}`}>{selectedSpc.status}</span></div>
                <div className="twin-spc-grid">
                  <div><span>Cp</span><b>{selectedSpc.cp.toFixed(2)}</b></div>
                  <div><span>Cpk</span><b className={selectedSpc.cpk >= 1.67 ? 'good' : selectedSpc.cpk >= 1.33 ? '' : 'bad'}>{selectedSpc.cpk.toFixed(2)}</b></div>
                  <div><span>SIGMA</span><b>{selectedSpc.sigma.toFixed(2)} σ</b></div>
                </div>
                <div className={`twin-spc-rule ${selectedSpc.rule.startsWith('Rule') ? 'alarm' : ''}`}><span>Nelson Run Rules</span><b>{selectedSpc.rule}</b></div>
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
            onClose={() => { scene.current?.clearSelection(); setSelection(undefined); setSelected(undefined); }}
            onManualKey={handleManualKey}
            onSelectReference={(id) => handleTwinSelection({ kind: 'reference', id })}
          />
        )}

        {mode === 'research' && (
          <section id="research-hud" className="twin-research-hud" aria-label="Research Replay">
            <div className="twin-research-head">
              <span className="technical">RESEARCH REPLAY · JSONL</span>
              <span>{research ? `${research.eventCount.toLocaleString('en-US')} rows` : 'display projection'}</span>
            </div>
            {researchLoading && <p className="twin-research-status">{t("正在载入 27,263 行展示事件…")}</p>}
            {researchError && <p className="twin-research-status error-text">{t("回放加载失败：")}{researchError}</p>}
            {research && researchSnapshot && (
              <>
                <div className="twin-research-clock">
                  <strong id="research-time-clock">{researchClock(researchTime)}</strong>
                  <span>{researchTime.toFixed(0)} s / {research.durationSec.toFixed(0)} s</span>
                </div>
                <input
                  id="research-scrubber"
                  className="twin-research-scrubber"
                  type="range"
                  min={0}
                  max={Math.max(1, research.durationSec)}
                  step={1}
                  value={researchTime}
                  onChange={(event) => { setResearchPlaying(false); setResearchTime(Number(event.target.value)); }}
                  aria-label={t("回放时间轴")}
                />
                <div className="twin-research-controls">
                  <button id="research-play-btn" type="button" onClick={() => { if (researchTime >= research.durationSec) setResearchTime(0); setResearchPlaying(!researchPlaying); }}>{researchPlaying ? t("暂停") : t("播放")}</button>
                  {([1, 10, 100, 500] as const).map((speed) => (
                    <button type="button" key={speed} className={researchSpeed === speed ? 'active' : ''} onClick={() => setResearchSpeed(speed)}>{speed}×</button>
                  ))}
                </div>
                <div className="twin-research-stats">
                  <div><span>WIP</span><strong id="research-wip-val">{researchSnapshot.wip} lots</strong><small>{researchSnapshot.wip * 25} wafers</small></div>
                  <div><span>ACTIVE</span><strong>{researchSnapshot.activeTools}</strong><small>tools</small></div>
                  <div><span>TOP UTIL</span><strong>{(researchSnapshot.utilization[0]?.utilization ?? 0).toFixed(1)}%</strong><small>{researchSnapshot.utilization[0]?.toolGroup ?? '—'}</small></div>
                </div>
                <button id="btn-toggle-util-overlay" type="button" className="twin-research-util-toggle" aria-pressed={showResearchUtil} onClick={() => setShowResearchUtil((open) => !open)}>{t("利用率热力图")}</button>
                {showResearchUtil && <div id="research-utilization-overlay" className="twin-research-util">
                  {researchSnapshot.utilization.slice(0, 4).map((group) => (
                    <div key={group.toolGroup}>
                      <span>{group.toolGroup}</span>
                      <i><b style={{ width: `${Math.min(100, group.utilization)}%` }} /></i>
                      <em>{group.busy}/{group.total}</em>
                    </div>
                  ))}
                </div>}
                <div id="research-amhs-badge" className="twin-research-amhs">AMHS SIMULATED · jobs {amhs?.completed ?? 0} · avg {amhs?.avgDelivery?.toFixed(1) ?? '—'} s · active {amhs?.active ?? 0}/24</div>
                <p className="twin-research-footnote">{t("只读展示事件流，不是 Checkpoint/WAL。原版别名命中")}{replayProjection?.mappedCount ?? 0}{t("/121 台；未映射设备保留进入回放前的状态。217 台仿真设备与布局不是一一对应。AMHS 为独立动画时钟，JSONL 无运输事件。")}</p>
              </>
            )}
          </section>
        )}

        {waferActive && (
          <section id="wafer-follow-panel" className="twin-wafer" aria-label="Wafer Follow">
            <div className="twin-wafer-head"><span>WAFER FOLLOW</span><button type="button" onClick={closeWafer} aria-label={t("关闭晶圆跟随")}>×</button></div>
            {waferError && <p className="twin-wafer-error">{t("路线加载失败：")}{waferError}</p>}
            {!waferRoutes && !waferError && <p className="twin-wafer-error">{t("正在加载 A/B/C 路线…")}</p>}
            {waferRoutes && (
              <>
                <div className="twin-wafer-row">
                  <label>Product
                    <select value={waferProduct} onChange={(event) => changeWaferProduct(event.target.value as WaferProduct)} aria-label={t("晶圆产品")}>
                      <option value="A">A · 120 Steps</option>
                      <option value="B">B · 104 Steps</option>
                      <option value="C">C · 92 Steps</option>
                    </select>
                  </label>
                  <b>{String(waferIndex + 1).padStart(3, '0')} / {String(waferWaypoints.length).padStart(3, '0')}</b>
                </div>
                <div className="twin-wafer-step">
                  <strong>{waferPoint?.tool?.model ?? '—'}</strong>
                  <span>{waferPoint?.toolGroup ?? ''} · {waferPoint?.recipe ?? 'no recipe'}</span>
                  <small>{waferPoint ? (language === 'zh' ? CATEGORY_BAYS[waferPoint.category]?.[0] : CATEGORY_BAYS[waferPoint.category]?.[1]) ?? waferPoint.category : ''}</small>
                  <em className="twin-wafer-status">{waferIndex >= waferWaypoints.length - 1 && !waferPlaying ? t('路线完成') : waferPlaying ? t('晶圆流转中…') : t('已暂停')}</em>
                </div>
                <input className="twin-wafer-scrubber" type="range" min={0} max={Math.max(0, waferWaypoints.length - 1)} step={1} value={waferIndex} onChange={(event) => seekWafer(Number(event.target.value))} aria-label={t("晶圆路线步骤")} />
                <div className="twin-wafer-actions">
                  <button type="button" onClick={() => setWaferPlaying(!waferPlaying)}>{waferPlaying ? t("暂停") : t("播放")}</button>
                  <button type="button" onClick={replayWafer}>{t("重播")}</button>
                  {([1, 4, 16] as const).map((speed) => <button type="button" key={speed} className={waferSpeed === speed ? 'active' : ''} onClick={() => setWaferSpeed(speed)}>{speed}×</button>)}
                  <label><input type="checkbox" checked={waferFollow} onChange={(event) => setWaferFollow(event.target.checked)} />{t("跟随")}</label>
                </div>
              </>
            )}
          </section>
        )}

        {ymsOpen && (
          <div className="twin-yms-backdrop" onClick={() => setYmsOpen(false)}>
            <section className="twin-yms" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="YMS yield management">
              <header className="twin-yms-head">
                <div><strong>YMS · YIELD MANAGEMENT</strong><span>WM-811K SPATIAL CLASSIFIER · 8-STAGE CASCADING YIELD</span></div>
                <nav>
                  <button type="button" className={ymsTab === 'map' ? 'active' : ''} onClick={() => setYmsTab('map')}>Wafer Map</button>
                  <button type="button" className={ymsTab === 'yield' ? 'active' : ''} onClick={() => setYmsTab('yield')}>Yield Waterfall</button>
                </nav>
                <button type="button" className="twin-yms-close" aria-label={t("关闭 YMS")} onClick={() => setYmsOpen(false)}>×</button>
              </header>

              {ymsTab === 'map' ? (
                <div className="twin-yms-map">
                  <aside className="twin-patterns">
                    <span className="twin-yms-label">WM-811K PATTERNS</span>
                    {(Object.keys(WM811K_DEFECT_METADATA) as DefectPattern[]).map((pattern) => (
                      <button type="button" key={pattern} className={waferPattern === pattern ? 'active' : ''} onClick={() => { setWaferPattern(pattern); setWaferSeed((seed) => seed + 1); }}>
                        <b>{WM811K_DEFECT_METADATA[pattern].name}</b>
                        <small>{WM811K_DEFECT_METADATA[pattern].confidence} confidence</small>
                      </button>
                    ))}
                    <button type="button" className="twin-yms-random" onClick={() => { const patterns = Object.keys(WM811K_DEFECT_METADATA) as DefectPattern[]; setWaferPattern(patterns[Math.floor(Math.random() * patterns.length)]); setWaferSeed((seed) => seed + 1); }}>{t("随机模式")}</button>
                  </aside>
                  <div className="twin-wafer-stage">
                    <svg viewBox="0 0 320 320" role="img" aria-label="300mm wafer die map">
                      <circle cx="160" cy="160" r="149" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="3" />
                      <circle cx="160" cy="160" r="145" fill="#0f172a" stroke="#94a3b8" strokeWidth="1.5" />
                      <circle cx="160" cy="160" r="139" fill="#1e293b" opacity="0.6" />
                      {waferDies.map((die) => (
                        <rect key={`${die.r}-${die.c}`} x={160 + die.dx - 5.15} y={160 + die.dy - 5.15} width={10.3} height={10.3} rx={1.5} fill={BIN_COLORS[die.bin]} stroke="#fff" strokeWidth={0.3} onMouseEnter={() => setHoverDie({ r: die.r, c: die.c, bin: die.bin })} onMouseLeave={() => setHoverDie(undefined)} />
                      ))}
                      <path d="M152 305 Q160 295 168 305" fill="none" stroke="#64748b" strokeWidth="2" />
                    </svg>
                    <div className="twin-wafer-hover">{hoverDie ? `Die [R${hoverDie.r}, C${hoverDie.c}] · ${BIN_LABELS[hoverDie.bin]}` : `300 mm · ${waferAnalytics.total} dies · Notch 180°`}</div>
                  </div>
                  <aside className="twin-yms-analytics">
                    <div className="twin-yms-pattern"><span>CLASSIFIED PATTERN</span><b>{WM811K_DEFECT_METADATA[waferPattern].name}</b><small>Confidence {WM811K_DEFECT_METADATA[waferPattern].confidence}</small></div>
                    <p>{WM811K_DEFECT_METADATA[waferPattern].desc}</p>
                    <div className="twin-yms-cause"><span>ROOT CAUSE</span>{WM811K_DEFECT_METADATA[waferPattern].rootCause}</div>
                    <div className="twin-yms-yield-row"><div><span>GROSS YIELD</span><b>{waferAnalytics.yieldPct.toFixed(1)}%</b><small>{waferAnalytics.good} / {waferAnalytics.total} dies</small></div><div><span>MODEL LOSS</span><b>{WM811K_DEFECT_METADATA[waferPattern].lossPct.toFixed(1)}%</b><small>D0 {waferAnalytics.d0.toFixed(3)}/cm²</small></div></div>
                    <div className="twin-bin-list">
                      {([1, 2, 3, 4, 5] as BinCode[]).map((bin) => <div key={bin}><i style={{ background: BIN_COLORS[bin] }} /><span>{BIN_LABELS[bin]}</span><b>{waferAnalytics.bins[bin]} · {((waferAnalytics.bins[bin] / Math.max(1, waferAnalytics.total)) * 100).toFixed(1)}%</b></div>)}
                    </div>
                    <div className="twin-yield-models">
                      <span className="twin-yms-label">THEORETICAL YIELD MODELS</span>
                      <label>Die area <b>{dieArea} mm²</b><input type="range" min={25} max={300} step={5} value={dieArea} onChange={(event) => setDieArea(Number(event.target.value))} /></label>
                      <label>Defect D0 <b>{defectD0.toFixed(2)} /cm²</b><input type="range" min={0.02} max={0.6} step={0.01} value={defectD0} onChange={(event) => setDefectD0(Number(event.target.value))} /></label>
                      <label>Cluster α <b>{clusterAlpha.toFixed(2)}</b><input type="range" min={0.5} max={6} step={0.1} value={clusterAlpha} onChange={(event) => setClusterAlpha(Number(event.target.value))} /></label>
                      <div className="twin-model-grid"><div><span>POISSON</span><b>{yieldModels.poisson.toFixed(1)}%</b></div><div><span>MURPHY</span><b>{yieldModels.murphy.toFixed(1)}%</b></div><div><span>SEEDS</span><b>{yieldModels.seeds.toFixed(1)}%</b></div></div>
                    </div>
                    <div className="twin-stdf-head"><span>STDF V4 PREVIEW</span><button type="button" onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(stdf, null, 2)).then(() => { setStdfCopied(true); window.setTimeout(() => setStdfCopied(false), 1800); }).catch(() => {}); }}>{stdfCopied ? 'Copied' : 'Copy JSON'}</button></div>
                    <pre className="twin-stdf">{`MIR: LotID="LOT-300-8842", TestCode="CP1", Fab="FAB-1", Tester="ADVANTEST-V93K"
WIR: WaferID="W-14", Diameter=300mm, Notch=180, TotalDies=${waferAnalytics.total}, Tested=${waferAnalytics.total}
PRR: PassCount=${waferAnalytics.good}, FailCount=${waferAnalytics.total - waferAnalytics.good}, GrossYield=${waferAnalytics.yieldPct.toFixed(2)}%, D0_Est=${waferAnalytics.d0.toFixed(3)}/cm²
BIN_SUMMARY: Bin1=${waferAnalytics.bins[1]}, Bin2=${waferAnalytics.bins[2]}, Bin3=${waferAnalytics.bins[3]}, Bin4=${waferAnalytics.bins[4]}, Bin5=${waferAnalytics.bins[5]}`}</pre>
                  </aside>
                </div>
              ) : (
                <div className="twin-yield-view">
                  <div className="twin-yield-summary">
                    <div><span>OVERALL FAB YIELD</span><b>{(fabYield.totalYield * 100).toFixed(2)}%</b><small>Y_fab = ∏ Y_i</small></div>
                    <div><span>EFFECTIVE CAPACITY</span><b>{fabYield.wpm.toLocaleString()}</b><small>wafers / month</small></div>
                    <div><span>BOTTLENECK</span><b>{fabYield.bottleneck.short}</b><small>{fabYield.bottleneck.name}</small></div>
                  </div>
                  <div className="twin-yield-scenarios" aria-label="Yield scenarios">
                    <button type="button" className={yieldScenario === 'live' ? 'active' : ''} onClick={() => chooseYieldScenario('live')}>LIVE</button>
                    {YIELD_SCENARIOS.map((scenario) => <button type="button" key={scenario.id} className={yieldScenario === scenario.id ? 'active' : ''} onClick={() => chooseYieldScenario(scenario.id)}>{scenario.name}</button>)}
                  </div>
                  {yieldUnresolved.length > 0 && <p className="twin-data-note">{t("此原版场景的旧设备 ID 不在当前布局中，未施加类别级 DOWN：")}{yieldUnresolved.join(', ')}</p>}
                  <div className="twin-yield-bars">
                    {fabYield.modules.map((entry) => (
                      <div key={entry.module.id} className={entry.bottleneck ? 'bottleneck' : ''}>
                        <span className="twin-yield-icon">{entry.module.icon}</span>
                        <span className="twin-yield-name">{entry.module.short} · {entry.module.name}</span>
                        <b className="twin-yield-step">{(entry.stepYield * 100).toFixed(2)}%</b>
                        <i><b style={{ width: `${Math.min(100, entry.cumulativeYield * 100)}%` }} /></i>
                        <em>{(entry.cumulativeYield * 100).toFixed(1)}%</em>
                        {entry.bottleneck && <strong>BOTTLENECK</strong>}
                      </div>
                    ))}
                  </div>
                  <div className="twin-yield-inputs">
                    <label>Raw material purity <b>{yieldInput.purity.toFixed(1)}N</b><input type="range" min={4} max={6} step={0.1} value={yieldInput.purity} onChange={(event) => setYieldInput((current) => ({ ...current, purity: Number(event.target.value) }))} /></label>
                    <label>Equipment health <b>{yieldInput.health.toFixed(1)}%</b><input type="range" min={70} max={100} step={0.1} value={yieldInput.health} onChange={(event) => setYieldInput((current) => ({ ...current, health: Number(event.target.value) }))} /></label>
                    <label>Queue lag <b>{yieldInput.lagTime.toFixed(1)} h</b><input type="range" min={0} max={16} step={0.1} value={yieldInput.lagTime} onChange={(event) => setYieldInput((current) => ({ ...current, lagTime: Number(event.target.value) }))} /></label>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        <div id="hud-grid-badge" className="twin-grid-badge"><OriginalIcon name="ruler" />{t("网格: 6m × 6m · Subfab: -7.0m")}</div>

        <footer id="bottom-hud-footer" className="twin-bottom">
          <span className="twin-status" title={status}><i className={status.startsWith('WebGPU') ? 'ok' : ''} />{status.startsWith('WebGPU') ? 'WebGPU' : status}</span>
          <span>{t("FAB-01 · 单 FAB")}</span>
          <span className="twin-footer-legend" aria-label={t("工艺分区图例")}>{[['光刻','#d99e3d'],['刻蚀','#c26b6b'],['薄膜','#d68a4a'],['Cu','#a98467'],['注入','#8b7bb5'],['扩散','#5c9b78'],['CMP/清洗','#4f9b9b'],['量测','#5b82b5'],['封装','#b06c96'],['Subfab','#4f6fa8']].map(([name,color])=><i key={name} title={name} style={{background:color}} />)}</span>
          <span>{mode === 'research' ? 'JSONL display only' : `AMHS OHT ${String(amhs?.active ?? 0).padStart(2, '0')}/${amhs?.total ?? 24}`}</span>
          <span>{mode === 'research' ? `REPLAY · WIP ${researchSnapshot?.wip ?? 0} · ACTIVE ${researchSnapshot?.activeTools ?? 0}` : `${stateCounts.running} RUN · ${stateCounts.idle} IDLE · ${stateCounts.down} DOWN · ${stateCounts.maint} MAINT`}</span>
        </footer>


        {xrayFilter && (
          <div className="twin-xray" role="group" aria-label={t("X-Ray 过滤")}>
            <span>X-RAY</span>
            {XRAY_FILTERS.map(({ filter, label }) => (
              <button type="button" key={filter} className={xrayFilter === filter ? 'active' : ''} onClick={() => applyXRayFilter(filter)}>{label}</button>
            ))}
            <button type="button" className="close" onClick={() => applyXRayFilter(null)} aria-label={t("关闭 X-Ray")}>×</button>
          </div>
        )}

        {tourStep !== undefined && TOUR_STOPS[tourStep] && (
          <section id="cinematic-hud" className="twin-tour-card" aria-label="Cinematic Tour">
            <div className="twin-tour-head">
              <span>TOUR {tourStep + 1}/{TOUR_STOPS.length}</span>
              <button type="button" onClick={endTour} aria-label={t("关闭导览")}>{t("跳过")}</button>
            </div>
            <h3 id="tour-hud-title">{language === 'zh' ? TOUR_STOPS[tourStep].title : TOUR_STOPS[tourStep].titleEn}</h3>
            <p id="tour-hud-desc">{language === 'zh' ? TOUR_STOPS[tourStep].subtitle : TOUR_STOPS[tourStep].subtitleEn}</p>
            <div id="tour-dots-container" className="twin-tour-dots" role="tablist" aria-label={t("导览站点")}>
              {TOUR_STOPS.map((stop, index) => (
                <button id={`tour-dot-${index}`} type="button" role="tab" aria-selected={index === tourStep} key={stop.title} className={index === tourStep ? 'active' : ''} onClick={() => applyTourStep(index)} aria-label={language === 'zh' ? stop.title : stop.titleEn} />
              ))}
            </div>
            <div className="twin-tour-actions">
              <button type="button" onClick={previousTour} disabled={tourStep === 0}>{t("上一步")}</button>
              <button type="button" className="primary" onClick={advanceTour}>{tourStep === TOUR_STOPS.length - 1 ? t("完成") : t("下一站")}</button>
            </div>
          </section>
        )}

        {infoDialog && (
          <div className="twin-yms-backdrop" onClick={() => setInfoDialog(null)}>
            <section className="twin-yms" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={infoDialog}>
              <header className="twin-yms-head"><div><strong>{infoDialog === 'architecture' ? 'OPEN SOFTWARE ARCHITECTURE' : 'OEM DATABASE'}</strong><span>{infoDialog === 'architecture' ? 'React + TypeScript + Babylon.js WebGPU' : '116 SEMI-E72 records'}</span></div><button type="button" className="twin-yms-close" onClick={() => setInfoDialog(null)}>×</button></header>
              <div className="twin-info-dialog">{infoDialog === 'architecture' ? <><p>Single-FAB procedural WebGPU runtime. React owns the page and typed HUD state; Babylon owns the WebGPU scene, native static shadows and cut plane.</p><p>No Three.js, WebGL fallback, iframe original page or glTF loaders are used in the production runtime.</p></> : <><p>The OEM tab contains all 116 source catalog rows. Selecting a row keeps the page in <code>/twin</code> and opens its source/spec record in the inspector.</p><p>Draft layout instances remain selectable in the 3D scene and are intentionally not treated as 121 directory cards.</p></>}</div>
            </section>
          </div>
        )}

        {onboarding && (
          <div id="onboarding-bubble" className="twin-onboarding" role="dialog" aria-modal="false" aria-label={t("首次引导")}>
            <div className="twin-onboarding-card">
              <div className="twin-onboarding-head"><span id="onboarding-step-counter">{t("首次进入 ·")}{onboardingStep + 1}/{ONBOARDING_STEPS.length}</span><button type="button" onClick={dismissOnboarding} aria-label={t("跳过引导")}>×</button></div>
              <h3 id="onboarding-title">{t(ONBOARDING_STEPS[onboardingStep].title)}</h3>
              <p id="onboarding-desc">{t(ONBOARDING_STEPS[onboardingStep].body)}</p>
              <div className="twin-onboarding-actions">
                <button type="button" onClick={dismissOnboarding}>{t("跳过")}</button>
                <button id="onboarding-prev-btn" type="button" onClick={() => dispatch({ type: 'onboarding/step', step: onboardingStep - 1 })} disabled={onboardingStep === 0}>{t("上一步")}</button>
                <button id="onboarding-next-btn" type="button" className="primary" onClick={() => { if (onboardingStep === ONBOARDING_STEPS.length - 1) finishOnboarding(); else dispatch({ type: 'onboarding/step', step: onboardingStep + 1 }); }}>{onboardingStep === ONBOARDING_STEPS.length - 1 ? t("开始导览") : t("下一步")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export function TwinPage() { return <TwinLocaleProvider><TwinContent /></TwinLocaleProvider>; }
