import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from './api-client';
import type { SiteDto } from './contracts';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus } from './equipment-status';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { AmhsStats, CutAxis, PickedTool, SceneLayer, XRayFilter } from './fab-scene';
import { FabRail, SiteScene, type SiteSceneHandle } from './site-preview';
import { ResearchReplay, researchClock } from './research-replay';
import { buildWaferWaypoints, parseWaferRoutes, waferTransitPoint, type WaferProduct, type WaferRouteStep } from './wafer-route';
import { applyMesAction, buildTelemetry, computeSpc, createMesJob, type MesAction, type MesJob } from './process-control';
import { BIN_COLORS, BIN_LABELS, WM811K_DEFECT_METADATA, generateWaferMap, stdfSummary, theoreticalYieldModels, waferMetrics, type BinCode, type DefectPattern } from './wafer-map';
import { computeFabYield, DEFAULT_YIELD_INPUT, scenarioStates, YIELD_SCENARIOS } from './fab-yield';
type EntryMode = 'visitor' | 'engineer' | 'research';
type CameraView = 'iso' | 'top' | 'litho' | 'airshower' | 'etch' | 'oht';
type FabLevel = 'L1' | 'B1' | 'DUAL' | 'EXPLODED';
type TourStop = {
  title: string;
  subtitle: string;
  preset?: CameraView;
  level?: 'L1' | 'B1';
};

const TOUR_STOPS: TourStop[] = [
  { title: '宏观 FAB', subtitle: '121 台设备 · 单 FAB 洁净室', preset: 'iso' },
  { title: '光刻与风淋', subtitle: 'EUV / 高 NA · 人员气闸', preset: 'litho' },
  { title: '刻蚀与沉积', subtitle: '多腔体集群与厂务管线', preset: 'etch' },
  { title: 'AMHS 双环', subtitle: '24 台 OHT · 空中运输', preset: 'oht' },
  { title: 'Subfab 地下层', subtitle: 'UPW / PCW / 气体 / 真空', level: 'B1' },
];
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

const LAYER_LABELS: { layer: SceneLayer; label: string }[] = [
  { layer: 'amhs', label: 'AMHS' },
  { layer: 'ceiling', label: 'FFU' },
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

export function TwinPage() {
  const scene = useRef<SiteSceneHandle>(null);
  const [site, setSite] = useState<SiteDto>();
  const [error, setError] = useState<string>();
  const [toolStates, setToolStates] = useState<FabToolState[]>(() => [...FAB_TOOL_STATES]);
  const [statusFeed, setStatusFeed] = useState<{ updatedAt: string; stale: boolean }>();
  const [layers, setLayers] = useState<Record<SceneLayer, boolean>>({
    amhs: true,
    ceiling: false,
    subfab: false,
    heatmap: false,
    airflow: false,
    xray: false,
  });
  const [view, setView] = useState<CameraView>('iso');
  const [level, setLevel] = useState<FabLevel>('L1');
  const [explodePercent, setExplodePercent] = useState(100);
  const [cutActive, setCutActive] = useState(false);
  const [cutAxis, setCutAxis] = useState<CutAxis>('X');
  const [cutPosition, setCutPosition] = useState(0);
  const [cutInvert, setCutInvert] = useState(false);
  const [xrayFilter, setXRayFilter] = useState<XRayFilter | null>(null);
  const [mode, setMode] = useState<EntryMode>('engineer');
  const [tourStep, setTourStep] = useState<number>();
  const [onboarding, setOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [exploded, setExploded] = useState(false);
  const [basement, setBasement] = useState(false);
  const [selected, setSelected] = useState<PickedTool>();
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
  const [status, setStatus] = useState('准备 WebGPU 视图…');
  const [amhs, setAmhs] = useState<AmhsStats>();
  const [railOpen, setRailOpen] = useState(true);
  const [research, setResearch] = useState<ResearchReplay>();
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [researchTime, setResearchTime] = useState(0);
  const [researchPlaying, setResearchPlaying] = useState(false);
  const [researchSpeed, setResearchSpeed] = useState<1 | 10 | 100 | 500>(10);
  const [waferActive, setWaferActive] = useState(false);
  const [waferProduct, setWaferProduct] = useState<WaferProduct>('A');
  const [waferRoutes, setWaferRoutes] = useState<Record<WaferProduct, WaferRouteStep[]>>();
  const [waferIndex, setWaferIndex] = useState(0);
  const [waferPlaying, setWaferPlaying] = useState(false);
  const [waferSpeed, setWaferSpeed] = useState<1 | 4 | 16>(1);
  const [waferFollow, setWaferFollow] = useState(true);
  const [waferError, setWaferError] = useState('');
  const waferIndexRef = useRef(0);
  const waferProgressRef = useRef(0);
  const waferTrailRef = useRef<[number, number, number][]>([]);
  const modeRef = useRef<EntryMode>('engineer');

  useEffect(() => {
    const controller = new AbortController();
    void new ApiClient().sites(controller.signal)
      .then((sites) => {
        if (controller.signal.aborted) return;
        const wanted = new URL(location.href).searchParams.get('siteId');
        const next = wanted ? sites.find((value) => value.siteId === wanted) : sites[0];
        if (!next) throw new Error(wanted ? `指定的 FAB 站点不存在：${wanted}` : '没有可用的 FAB 站点');
        if (next.fabs.length !== 1) throw new Error('当前产品必须只有一个 FAB');
        setSite(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'FAB 数据加载失败');
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
        if (modeRef.current !== 'research') {
          setToolStates(next);
          next.forEach((state, index) => scene.current?.setToolState(index, state));
        }
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
    if (site) document.title = `${site.code} / FAB-01 · 3D FAB`;
  }, [site]);

  useEffect(() => {
    modeRef.current = mode;
    if (mode !== 'research') setResearchPlaying(false);
  }, [mode]);

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
        if (!controller.signal.aborted) setResearchError(reason instanceof Error ? reason.message : '回放数据加载失败');
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
      setResearchTime((current) => {
        const next = Math.min(research.durationSec, current + elapsed);
        if (next >= research.durationSec) setResearchPlaying(false);
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [researchPlaying, research, researchSpeed]);

  const researchSnapshot = useMemo(() => research?.snapshot(researchTime), [research, researchTime]);

  useEffect(() => {
    if (!waferActive || waferRoutes) return;
    const controller = new AbortController();
    setWaferError('');
    void fetch('/twin/routes.json', { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<unknown>; })
      .then((value) => { if (!controller.signal.aborted) setWaferRoutes(parseWaferRoutes(value)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setWaferError(reason instanceof Error ? reason.message : '路线加载失败'); });
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
      if (!waferActive) scene.current?.setWaferPoint(0, 0, 0, false, false);
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
      if (localStorage.getItem(ONBOARDING_KEY) !== '1') setOnboarding(true);
    } catch {
      // Storage may be blocked; the page still works without onboarding memory.
    }
  }, []);

  useEffect(() => {
    if (tourStep === undefined) return;
    const timer = window.setTimeout(() => advanceTour(), 9000);
    return () => window.clearTimeout(timer);
  }, [tourStep]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === '1') setCamera('iso');
      if (event.key === '2') setCamera('top');
      if (event.key === 'Escape') {
        scene.current?.clearSelection();
        setSelected(undefined);
      }
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

  function setCamera(next: CameraView): void {
    setView(next);
    scene.current?.setView(next);
  }
  function toggleLayer(layer: SceneLayer): void {
    setLayers((current) => {
      const next = { ...current, [layer]: !current[layer] };
      scene.current?.setLayer(layer, next[layer]);
      return next;
    });
  }
  function disableCut(): void {
    if (cutActive) scene.current?.setCutPlane(false, cutAxis, cutPosition, cutInvert);
    setCutActive(false);
  }
  function applyXRayFilter(filter: XRayFilter | null): void {
    setXRayFilter(filter);
    setLayers((current) => ({ ...current, xray: filter !== null }));
    if (filter && filter !== 'all' && filter !== 'amhs') {
      scene.current?.setBasement(false);
      scene.current?.setDual(true);
      setBasement(false);
      setExploded(false);
      setLevel('DUAL');
    }
    scene.current?.setXRayFilter(filter);
  }
  function resetLevel(): void {
    disableCut();
    scene.current?.setDual(false);
    if (basement) scene.current?.setBasement(false);
    if (exploded) scene.current?.setExploded(false);
    scene.current?.setExplodeFactor(0);
    setBasement(false);
    setExploded(false);
    setLevel('L1');
  }
  function toggleCut(): void {
    if (cutActive) { disableCut(); return; }
    resetLevel();
    scene.current?.setCutPlane(true, cutAxis, cutPosition, cutInvert);
    setCutActive(true);
  }
  function updateCut(axis: CutAxis, position: number, invert: boolean): void {
    setCutAxis(axis);
    setCutPosition(position);
    setCutInvert(invert);
    if (cutActive) scene.current?.setCutPlane(true, axis, position, invert);
  }
  function setL1(): void {
    resetLevel();
  }
  function setB1(): void {
    if (level === 'B1') { resetLevel(); return; }
    disableCut();
    scene.current?.setDual(false);
    if (exploded) scene.current?.setExploded(false);
    scene.current?.setExplodeFactor(0);
    scene.current?.setBasement(true);
    setBasement(true);
    setExploded(false);
    setLevel('B1');
  }
  function setDual(): void {
    if (level === 'DUAL') { resetLevel(); return; }
    disableCut();
    if (basement) scene.current?.setBasement(false);
    if (exploded) scene.current?.setExploded(false);
    scene.current?.setExplodeFactor(0);
    scene.current?.setDual(true);
    setBasement(false);
    setExploded(false);
    setLevel('DUAL');
  }
  function toggleExploded(): void {
    if (level === 'EXPLODED') { resetLevel(); return; }
    disableCut();
    scene.current?.setDual(false);
    if (basement) scene.current?.setBasement(false);
    scene.current?.setExplodeFactor(explodePercent / 100);
    setBasement(false);
    setExploded(true);
    setLevel('EXPLODED');
  }
  function changeExplode(value: number): void {
    setExplodePercent(value);
    setExploded(true);
    setLevel('EXPLODED');
    scene.current?.setExplodeFactor(value / 100);
  }
  function applyTourStep(index: number): void {
    const stop = TOUR_STOPS[index];
    if (!stop) return;
    setTourStep(index);
    setOnboarding(false);
    resetLevel();
    if (stop.level === 'B1') {
      scene.current?.setBasement(true);
      setBasement(true);
      setLevel('B1');
    } else {
      setCamera(stop.preset ?? 'iso');
    }
  }
  function chooseYieldScenario(id: string): void {
    setYieldScenario(id);
    const scenario = YIELD_SCENARIOS.find((entry) => entry.id === id);
    setYieldInput(scenario ? { purity: scenario.purity, health: scenario.health, lagTime: scenario.lagTime } : DEFAULT_YIELD_INPUT);
  }
  function runMesAction(action: MesAction): void {
    if (!selected) return;
    const index = selected.index;
    setMesJobs((current) => ({
      ...current,
      [index]: applyMesAction(current[index] ?? createMesJob(FAB_LAYOUT[index], index), action),
    }));
  }
  function clearWaferTrail(): void {
    waferIndexRef.current = 0;
    waferProgressRef.current = 0;
    waferTrailRef.current = [];
    scene.current?.setWaferTrail([]);
  }
  function startWafer(): void {
    setWaferActive(true);
    setWaferIndex(0);
    setWaferPlaying(false);
    setWaferProduct('A');
    clearWaferTrail();
  }
  function closeWafer(): void {
    setWaferActive(false);
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
    setTourStep(undefined);
    resetLevel();
    setCamera('iso');
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
    setOnboarding(false);
    try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* ignore storage denial */ }
  }
  function finishOnboarding(): void {
    dismissOnboarding();
    startTour();
  }

  if (error) {
    return <main className="twin-page twin-error"><h1>无法加载 FAB</h1><p>{error}</p><a href="/">返回工作台</a></main>;
  }
  if (!site || !fab) {
    return <main className="twin-page twin-loading"><span>正在加载 FAB…</span></main>;
  }

  return (
    <main className="twin-page">
      <header className="twin-topbar">
        <div className="twin-brand">
          <span className="twin-brand-mark">F</span>
          <div><strong>300mm 晶圆制造厂 (Fab)</strong><small>先进试验线 · FAB-01</small></div>
        </div>
        <div className="twin-topgroup">
          <label className="twin-mode">模式
            <select value={mode} onChange={(event) => setMode(event.target.value as EntryMode)}>
              <option value="visitor">Visitor 访客</option>
              <option value="engineer">Engineer 工程师</option>
              <option value="research">Research 研究</option>
            </select>
          </label>
          <div className="twin-levels" role="group" aria-label="楼层">
            <button type="button" className={level === 'L1' ? 'active' : ''} onClick={setL1}>L1</button>
            <button type="button" className={level === 'B1' ? 'active' : ''} onClick={setB1}>B1</button>
            <button type="button" className={level === 'DUAL' ? 'active' : ''} onClick={setDual}>Dual</button>
            <button type="button" className={level === 'EXPLODED' ? 'active' : ''} onClick={toggleExploded}>Explode</button>
          </div>
          <button type="button" className={`twin-cut-toggle${cutActive ? ' active' : ''}`} aria-pressed={cutActive} onClick={toggleCut}>Cut</button>
          <div className="twin-cameras" role="group" aria-label="相机预设">
            <button type="button" className={view === 'iso' ? 'active' : ''} onClick={() => setCamera('iso')}>ISO</button>
            <button type="button" className={view === 'top' ? 'active' : ''} onClick={() => setCamera('top')}>Top</button>
            <button type="button" onClick={() => setCamera('litho')}>Litho</button>
            <button type="button" onClick={() => setCamera('airshower')}>Airlock</button>
          </div>
          <button type="button" className={`twin-tour${tourStep !== undefined ? ' active' : ''}`} aria-pressed={tourStep !== undefined} onClick={() => { if (tourStep === undefined) startTour(); else endTour(); }}>▶ Tour</button>
          <button type="button" className={`twin-wafer-toggle${waferActive ? ' active' : ''}`} aria-pressed={waferActive} onClick={() => { if (waferActive) closeWafer(); else startWafer(); }}>Wafer</button>
          <button type="button" className={`twin-yms-toggle${ymsOpen ? ' active' : ''}`} aria-pressed={ymsOpen} onClick={() => setYmsOpen((open) => !open)}>YMS</button>
        </div>
        <div className="twin-topright">
          <span className={`twin-feed${mode === 'research' ? ' is-replay' : statusFeed?.stale ? ' is-stale' : ''}`}><i />{mode === 'research' ? 'REPLAY' : statusFeed?.stale ? 'CACHE' : 'LIVE'}</span>
          <a href="/">工作台</a>
        </div>
      </header>

      <div className="twin-kpis">
        {mode === 'research' && researchSnapshot ? (
          <>
            <span><b>{researchSnapshot.wip}</b> WIP</span>
            <span><b>{researchSnapshot.activeTools}</b> ACTIVE</span>
            <span>DAY <b>{researchClock(researchTime).split(' ')[1]}</b></span>
          </>
        ) : (
          <>
            <span><b>{utilization.toFixed(1)}%</b> UTIL</span>
            <span><b>{FAB_LAYOUT.length}</b> TOOLS</span>
            <span><b>{String(amhs?.active ?? 0).padStart(2, '0')}/{amhs?.total ?? 24}</b> OHT</span>
            <span><b>{stateCounts.down}</b> ALARM</span>
          </>
        )}
      </div>

      {level === 'EXPLODED' && (
        <div className="twin-explode" role="group" aria-label="爆炸视图">
          <span>EXPLODE</span>
          <input type="range" min={0} max={100} step={1} value={explodePercent} onChange={(event) => changeExplode(Number(event.target.value))} aria-label="爆炸视图比例" />
          <b>{explodePercent}%</b>
        </div>
      )}

      {cutActive && (
        <div className="twin-cut" role="group" aria-label="剖切平面">
          <span>CUT</span>
          <select value={cutAxis} onChange={(event) => updateCut(event.target.value as CutAxis, cutPosition, cutInvert)} aria-label="剖切轴">
            <option value="X">X</option><option value="Y">Y</option><option value="Z">Z</option>
          </select>
          <input type="range" min={-55} max={55} step={1} value={cutPosition} onChange={(event) => updateCut(cutAxis, Number(event.target.value), cutInvert)} aria-label="剖切位置" />
          <b>{cutPosition.toFixed(0)} m</b>
          <label><input type="checkbox" checked={cutInvert} onChange={(event) => updateCut(cutAxis, cutPosition, event.target.checked)} /> Invert</label>
        </div>
      )}

      <div className="twin-stage">
        <SiteScene
          ref={scene}
          site={site}
          fab={fab}
          expanded={false}
          chrome={false}
          toolStates={toolStates}
          onToolChange={setSelected}
          onStatusChange={setStatus}
          onAmhsStatsChange={setAmhs}
          layers={layers}
          onToggleLayer={toggleLayer}
          touring={false}
          onToggleTour={() => undefined}
          exploded={exploded}
          explodeFactor={level === 'EXPLODED' ? explodePercent / 100 : 0}
          onToggleExploded={toggleExploded}
          basement={basement}
          dual={level === 'DUAL'}
          onToggleBasement={setB1}
        />

        {railOpen && mode === 'engineer' && (
          <div className="twin-left">
            <div className="twin-panel-title"><span>FAB EQUIPMENT</span><button type="button" onClick={() => setRailOpen(false)} aria-label="收起设备清单">×</button></div>
            <FabRail
              selectedToolIndex={selected?.index}
              onSelectTool={(index) => scene.current?.selectTool(index, false)}
              toolStates={toolStates}
              statusFeed={statusFeed}
            />
          </div>
        )}
        {!railOpen && mode === 'engineer' && <button type="button" className="twin-rail-open" onClick={() => setRailOpen(true)}>设备清单 ›</button>}

        {selected && mode !== 'visitor' && (
          <aside className="twin-inspector" aria-label="设备详情">
            <div className="twin-panel-title"><span>SELECTED TOOL · {String(selected.index + 1).padStart(3, '0')}</span><button type="button" aria-label="关闭设备详情" onClick={() => { scene.current?.clearSelection(); setSelected(undefined); }}>×</button></div>
            <h2>{selected.vendor}</h2>
            <h3>{selected.model}</h3>
            <span className="twin-chip">{CATEGORY_LABELS[selected.category] ?? selected.category}</span>
            <span className="twin-chip">{FAB_TOOL_STATE_META[toolStates[selected.index] ?? selected.state].label}</span>
            <dl>
              <dt>FAB 实例</dt><dd>FAB-01 / #{String(selected.index + 1).padStart(3, '0')}</dd>
              <dt>尺寸 (mm)</dt><dd>{(selected.width * 1000).toFixed(0)} × {(selected.depth * 1000).toFixed(0)} × {(selected.height * 1000).toFixed(0)}</dd>
              <dt>位置 (m)</dt><dd>{selected.x.toFixed(2)}, {selected.z.toFixed(2)}</dd>
              <dt>来源</dt><dd>本地布局 / OEM 目录</dd>
            </dl>
            <button type="button" className="twin-primary" onClick={() => scene.current?.selectTool(selected.index, true)}>在场景中定位</button>

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

        {mode === 'research' && (
          <section className="twin-research-hud" aria-label="Research Replay">
            <div className="twin-research-head">
              <span className="technical">RESEARCH REPLAY · JSONL</span>
              <span>{research ? `${research.eventCount.toLocaleString('en-US')} rows` : 'display projection'}</span>
            </div>
            {researchLoading && <p className="twin-research-status">正在载入 27,263 行展示事件…</p>}
            {researchError && <p className="twin-research-status error-text">回放加载失败：{researchError}</p>}
            {research && researchSnapshot && (
              <>
                <div className="twin-research-clock">
                  <strong>{researchClock(researchTime)}</strong>
                  <span>{researchTime.toFixed(0)} s / {research.durationSec.toFixed(0)} s</span>
                </div>
                <input
                  className="twin-research-scrubber"
                  type="range"
                  min={0}
                  max={Math.max(1, research.durationSec)}
                  step={1}
                  value={researchTime}
                  onChange={(event) => { setResearchPlaying(false); setResearchTime(Number(event.target.value)); }}
                  aria-label="回放时间轴"
                />
                <div className="twin-research-controls">
                  <button type="button" onClick={() => { if (researchTime >= research.durationSec) setResearchTime(0); setResearchPlaying((playing) => !playing); }}>{researchPlaying ? '暂停' : '播放'}</button>
                  {([1, 10, 100, 500] as const).map((speed) => (
                    <button type="button" key={speed} className={researchSpeed === speed ? 'active' : ''} onClick={() => setResearchSpeed(speed)}>{speed}×</button>
                  ))}
                </div>
                <div className="twin-research-stats">
                  <div><span>WIP</span><strong>{researchSnapshot.wip} lots</strong><small>{researchSnapshot.wip * 25} wafers</small></div>
                  <div><span>ACTIVE</span><strong>{researchSnapshot.activeTools}</strong><small>tools</small></div>
                  <div><span>TOP UTIL</span><strong>{(researchSnapshot.utilization[0]?.utilization ?? 0).toFixed(1)}%</strong><small>{researchSnapshot.utilization[0]?.toolGroup ?? '—'}</small></div>
                </div>
                <div className="twin-research-util">
                  {researchSnapshot.utilization.slice(0, 4).map((group) => (
                    <div key={group.toolGroup}>
                      <span>{group.toolGroup}</span>
                      <i><b style={{ width: `${Math.min(100, group.utilization)}%` }} /></i>
                      <em>{group.busy}/{group.total}</em>
                    </div>
                  ))}
                </div>
                <p className="twin-research-footnote">只读展示事件流，不是 Checkpoint/WAL；本阶段为 WIP / UTIL 聚合回放，设备逐台着色仍待映射。</p>
              </>
            )}
          </section>
        )}

        {waferActive && (
          <section className="twin-wafer" aria-label="Wafer Follow">
            <div className="twin-wafer-head"><span>WAFER FOLLOW</span><button type="button" onClick={closeWafer} aria-label="关闭晶圆跟随">×</button></div>
            {waferError && <p className="twin-wafer-error">路线加载失败：{waferError}</p>}
            {!waferRoutes && !waferError && <p className="twin-wafer-error">正在加载 A/B/C 路线…</p>}
            {waferRoutes && (
              <>
                <div className="twin-wafer-row">
                  <label>Product
                    <select value={waferProduct} onChange={(event) => changeWaferProduct(event.target.value as WaferProduct)} aria-label="晶圆产品">
                      <option value="A">A · 120 Steps</option>
                      <option value="B">B · 104 Steps</option>
                      <option value="C">C · 92 Steps</option>
                    </select>
                  </label>
                  <b>{String(waferIndex + 1).padStart(3, '0')} / {String(waferWaypoints.length).padStart(3, '0')}</b>
                </div>
                <div className="twin-wafer-step">
                  <strong>{waferPoint?.tool?.model ?? '—'}</strong>
                  <span>{waferPoint?.toolGroup ?? ''} · {waferPoint?.category ?? ''}</span>
                  <small>{waferPoint?.recipe ?? 'no recipe'}</small>
                </div>
                <input className="twin-wafer-scrubber" type="range" min={0} max={Math.max(0, waferWaypoints.length - 1)} step={1} value={waferIndex} onChange={(event) => seekWafer(Number(event.target.value))} aria-label="晶圆路线步骤" />
                <div className="twin-wafer-actions">
                  <button type="button" onClick={() => setWaferPlaying((playing) => !playing)}>{waferPlaying ? '暂停' : '播放'}</button>
                  <button type="button" onClick={replayWafer}>重播</button>
                  {([1, 4, 16] as const).map((speed) => <button type="button" key={speed} className={waferSpeed === speed ? 'active' : ''} onClick={() => setWaferSpeed(speed)}>{speed}×</button>)}
                  <label><input type="checkbox" checked={waferFollow} onChange={(event) => setWaferFollow(event.target.checked)} /> 跟随</label>
                </div>
              </>
            )}
          </section>
        )}

        {ymsOpen && (
          <div className="twin-yms-backdrop" onClick={() => setYmsOpen(false)}>
            <section className="twin-yms" onClick={(event) => event.stopPropagation()} aria-label="YMS yield management">
              <header className="twin-yms-head">
                <div><strong>YMS · YIELD MANAGEMENT</strong><span>WM-811K SPATIAL CLASSIFIER · 8-STAGE CASCADING YIELD</span></div>
                <nav>
                  <button type="button" className={ymsTab === 'map' ? 'active' : ''} onClick={() => setYmsTab('map')}>Wafer Map</button>
                  <button type="button" className={ymsTab === 'yield' ? 'active' : ''} onClick={() => setYmsTab('yield')}>Yield Waterfall</button>
                </nav>
                <button type="button" className="twin-yms-close" aria-label="关闭 YMS" onClick={() => setYmsOpen(false)}>×</button>
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
                    <button type="button" className="twin-yms-random" onClick={() => { const patterns = Object.keys(WM811K_DEFECT_METADATA) as DefectPattern[]; setWaferPattern(patterns[Math.floor(Math.random() * patterns.length)]); setWaferSeed((seed) => seed + 1); }}>随机模式</button>
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

        <div className="twin-bottom">
          <span className="twin-status"><i className={status.startsWith('WebGPU') ? 'ok' : ''} />{status}</span>
          <span>FAB-01 · 单 FAB</span>
          <span>{mode === 'research' ? 'JSONL display only' : `AMHS OHT ${String(amhs?.active ?? 0).padStart(2, '0')}/${amhs?.total ?? 24}`}</span>
          <span>{mode === 'research' ? `REPLAY · WIP ${researchSnapshot?.wip ?? 0} · ACTIVE ${researchSnapshot?.activeTools ?? 0}` : `${stateCounts.running} RUN · ${stateCounts.idle} IDLE · ${stateCounts.down} DOWN · ${stateCounts.maint} MAINT`}</span>
        </div>

        <div className="twin-layers" aria-label="图层">
          {LAYER_LABELS.map(({ layer, label }) => (
            <button type="button" key={layer} className={layers[layer] ? 'active' : ''} aria-pressed={!!layers[layer]} onClick={() => toggleLayer(layer)}>{label}</button>
          ))}
          <button type="button" className={xrayFilter ? 'active' : ''} aria-pressed={!!xrayFilter} onClick={() => applyXRayFilter(xrayFilter ? null : 'all')}>X-Ray</button>
        </div>

        {xrayFilter && (
          <div className="twin-xray" role="group" aria-label="X-Ray 过滤">
            <span>X-RAY</span>
            {XRAY_FILTERS.map(({ filter, label }) => (
              <button type="button" key={filter} className={xrayFilter === filter ? 'active' : ''} onClick={() => applyXRayFilter(filter)}>{label}</button>
            ))}
            <button type="button" className="close" onClick={() => applyXRayFilter(null)} aria-label="关闭 X-Ray">×</button>
          </div>
        )}

        {tourStep !== undefined && TOUR_STOPS[tourStep] && (
          <section className="twin-tour-card" aria-label="Cinematic Tour">
            <div className="twin-tour-head">
              <span>TOUR {tourStep + 1}/{TOUR_STOPS.length}</span>
              <button type="button" onClick={endTour} aria-label="关闭导览">跳过</button>
            </div>
            <h3>{TOUR_STOPS[tourStep].title}</h3>
            <p>{TOUR_STOPS[tourStep].subtitle}</p>
            <div className="twin-tour-dots" role="tablist" aria-label="导览站点">
              {TOUR_STOPS.map((stop, index) => (
                <button type="button" role="tab" aria-selected={index === tourStep} key={stop.title} className={index === tourStep ? 'active' : ''} onClick={() => applyTourStep(index)} aria-label={stop.title} />
              ))}
            </div>
            <div className="twin-tour-actions">
              <button type="button" onClick={previousTour} disabled={tourStep === 0}>上一步</button>
              <button type="button" className="primary" onClick={advanceTour}>{tourStep === TOUR_STOPS.length - 1 ? '完成' : '下一站'}</button>
            </div>
          </section>
        )}

        {onboarding && (
          <div className="twin-onboarding" role="dialog" aria-modal="false" aria-label="首次引导">
            <div className="twin-onboarding-card">
              <div className="twin-onboarding-head"><span>首次进入 · {onboardingStep + 1}/{ONBOARDING_STEPS.length}</span><button type="button" onClick={dismissOnboarding} aria-label="跳过引导">×</button></div>
              <h3>{ONBOARDING_STEPS[onboardingStep].title}</h3>
              <p>{ONBOARDING_STEPS[onboardingStep].body}</p>
              <div className="twin-onboarding-actions">
                <button type="button" onClick={dismissOnboarding}>跳过</button>
                <button type="button" onClick={() => setOnboardingStep((step) => Math.max(0, step - 1))} disabled={onboardingStep === 0}>上一步</button>
                <button type="button" className="primary" onClick={() => { if (onboardingStep === ONBOARDING_STEPS.length - 1) finishOnboarding(); else setOnboardingStep((step) => step + 1); }}>{onboardingStep === ONBOARDING_STEPS.length - 1 ? '开始导览' : '下一步'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
