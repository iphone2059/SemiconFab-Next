import { useTwinLocale } from './twin-i18n';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { FabDto, SiteDto } from './contracts';
import { bindViewerZoom } from './viewer-zoom';
import { SceneFacade, type AmhsStats, type CutAxis, type HoveredTool, type PickedTool, type SceneLayer, type SceneViewPreset, type XRayFilter } from './fab-scene';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, type FabToolCategory, type FabToolState } from './fab-layout';

export interface FabViewportProps {
  site: SiteDto;
  fab: FabDto;
  toolStates: readonly FabToolState[];
  onToolChange?: (tool?: PickedTool) => void;
  layers: Record<SceneLayer, boolean>;
  explodeFactor: number;
  basement: boolean;
  dual: boolean;
  onStatusChange?: (status: string) => void;
  onAmhsStatsChange?: (stats: AmhsStats) => void;
}

export interface FabViewportHandle {
  setView(preset: SceneViewPreset): void;
  setCameraPose(position: readonly [number, number, number], target: readonly [number, number, number], durationMs: number): void;
  zoom(deltaY: number): void;
  resize(): void;
  reload(): void;
  selectTool(index: number, focus?: boolean): void;
  clearSelection(): void;
  setLayer(layer: SceneLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setTour(active: boolean): void;
  setExploded(active: boolean): void;
  setExplodeFactor(factor: number): void;
  setBasement(active: boolean): void;
  setDual(active: boolean): void;
  setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void;
  setXRayFilter(filter: XRayFilter | null): void;
  setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean): void;
  setWaferTrail(points: readonly (readonly [number, number, number])[]): void;
}

const TOOL_CATEGORY_LABELS: Record<string, string> = {
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

export const FabViewport = forwardRef<FabViewportHandle, FabViewportProps>(function FabViewport(
  { site, fab, toolStates, onToolChange, layers, explodeFactor, basement, dual, onStatusChange, onAmhsStatsChange },
  ref,
) {
  const { t } = useTwinLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const facade = useRef<SceneFacade | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(t("准备 WebGPU 视图…"));
  const [generation, setGeneration] = useState(0);
  const [selectedTool, setSelectedTool] = useState<PickedTool>();
  const [amhsStats, setAmhsStats] = useState<AmhsStats>();
  const [hoveredTool, setHoveredTool] = useState<HoveredTool>();

  useEffect(() => {
    const root = surface.current;
    if (root) return bindViewerZoom(root, (delta) => facade.current?.zoom(delta));
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const controller = new AbortController();
    let scene: SceneFacade | undefined;
    void import('./babylon-webgpu')
      .then(({ createWebGpuBackend }) => {
        if (controller.signal.aborted) return;
        scene = new SceneFacade(createWebGpuBackend());
        facade.current = scene;
        setSelectedTool(undefined);
        setAmhsStats(undefined);
        onToolChange?.(undefined);
        return scene.mount(
          element,
          [{ fabId: fab.fabId, code: fab.code, position: [0, 0, 0] }],
          (value) => {
            setStatus(value);
            onStatusChange?.(value);
            setReady(value.startsWith('WebGPU ·') || value.startsWith('WebGPU 设备'));
          },
          (tool) => {
            setSelectedTool(tool ?? undefined);
            onToolChange?.(tool ?? undefined);
          },
          (stats) => { setAmhsStats(stats); onAmhsStatsChange?.(stats); },
          (hover) => setHoveredTool(hover ?? undefined),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReady(false);
          setStatus(error instanceof Error ? error.message : t("场景初始化失败"));
        }
      });
    return () => {
      controller.abort();
      if (facade.current === scene) facade.current = undefined;
      scene?.dispose();
    };
  }, [site.siteId, fab.fabId, generation]);

  useImperativeHandle(
    ref,
    () => ({
      setView: (preset) => facade.current?.setView(preset),
      setCameraPose: (position, target, durationMs) => facade.current?.setCameraPose(position, target, durationMs),
      zoom: (deltaY) => facade.current?.zoom(deltaY),
      resize: () => facade.current?.resize(),
      reload: () => { setReady(false); setStatus(t("准备 WebGPU 视图…")); setGeneration((value) => value + 1); },
      selectTool: (index, focus) => facade.current?.selectTool(index, focus),
      clearSelection: () => facade.current?.clearSelection(),
      setLayer: (layer, visible) => facade.current?.setLayer(layer, visible),
      setToolState: (index, state) => facade.current?.setToolState(index, state),
      setTour: (active) => facade.current?.setTour(active),
      setExploded: (active) => facade.current?.setExploded(active),
      setExplodeFactor: (factor) => facade.current?.setExplodeFactor(factor),
      setBasement: (active) => facade.current?.setBasement(active),
      setDual: (active) => facade.current?.setDual(active),
      setCutPlane: (active, axis, position, invert) => facade.current?.setCutPlane(active, axis, position, invert),
      setXRayFilter: (filter) => facade.current?.setXRayFilter(filter),
      setWaferPoint: (x, y, z, visible, focus) => facade.current?.setWaferPoint(x, y, z, visible, focus),
      setWaferTrail: (points) => facade.current?.setWaferTrail(points),
    }),
    [],
  );

  useEffect(() => {
    facade.current?.clearSelection();
    setSelectedTool(undefined);
    onToolChange?.(undefined);
  }, [fab.fabId]);

  useEffect(() => {
    if (!ready) return;
    toolStates.forEach((state, index) => facade.current?.setToolState(index, state));
  }, [toolStates, ready]);

  useEffect(() => {
    if (!ready) return;
    for (const [layer, visible] of Object.entries(layers)) facade.current?.setLayer(layer as SceneLayer, visible);
  }, [layers, ready]);
  useEffect(() => {
    if (!ready) return;
    facade.current?.setExplodeFactor(explodeFactor);
  }, [explodeFactor, ready]);
  useEffect(() => { if (ready) facade.current?.setBasement(basement); }, [basement, ready]);
  useEffect(() => { if (ready) facade.current?.setDual(dual); }, [dual, ready]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      facade.current?.clearSelection();
      setSelectedTool(undefined);
      setHoveredTool(undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const hovered = hoveredTool?.tool;
  return (
    <div ref={surface} className="scene twin-canvas">
      <canvas ref={canvas} aria-label={t("FAB WebGPU 场景")} />
      {hovered && <div className="twin-hovercard" style={{ left: hoveredTool.x + 12, top: hoveredTool.y + 12 }}>
        <strong>{hovered.vendor} {hovered.model}</strong>
        <span>{t(FAB_TOOL_STATE_META[toolStates[hovered.index] ?? hovered.state].label)} · #{hovered.index + 1}</span>
      </div>}
      {!ready && <div className="twin-render-status" role="status">{status}<button type="button" onClick={() => { setReady(false); setGeneration((value) => value + 1); }}>{t("重新加载")}</button></div>}
    </div>
  );
});

export function FabRail({
  selectedToolIndex,
  onSelectTool,
  toolStates,
  statusFeed,
}: {
  selectedToolIndex?: number;
  onSelectTool: (index: number) => void;
  toolStates: readonly FabToolState[];
  statusFeed?: { updatedAt: string; stale: boolean };
}) {
  const { t } = useTwinLocale();
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | FabToolState>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | FabToolCategory>('all');
  const stateCounts = useMemo(() => {
    const counts: Record<FabToolState, number> = { running: 0, idle: 0, down: 0, maint: 0 };
    for (const state of toolStates) counts[state] += 1;
    return counts;
  }, [toolStates]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<FabToolCategory, number>();
    for (const tool of FAB_LAYOUT) counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, []);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return FAB_LAYOUT.map((tool, index) => ({ tool, index })).filter(({ tool, index }) =>
      (stateFilter === 'all' || toolStates[index] === stateFilter) &&
      (categoryFilter === 'all' || tool.category === categoryFilter) &&
      (!value ||
        tool.model.toLowerCase().includes(value) ||
        tool.vendor.toLowerCase().includes(value) ||
        tool.category.toLowerCase().includes(value) ||
        (TOOL_CATEGORY_LABELS[tool.category] ?? tool.category).toLowerCase().includes(value) ||
        t(TOOL_CATEGORY_LABELS[tool.category] ?? tool.category).toLowerCase().includes(value)),
    );
  }, [query, stateFilter, categoryFilter, toolStates, t]);
  const feedTime = statusFeed
    ? new Date(statusFeed.updatedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  return (
    <aside className="scene-rail" aria-label={t("FAB 设备清单")}>
      <div className="scene-rail-head">
        <span className="technical">FAB EQUIPMENT</span>
        <span className="rail-count">{FAB_LAYOUT.length}</span>
      </div>
      <div className="scene-rail-tabs" role="tablist" aria-label={t("设备目录")}>
        <button type="button" role="tab" aria-selected="true" className="active">FAB TOOLS <span>{FAB_LAYOUT.length}</span></button>
        <a role="tab" aria-selected="false" href="/catalog">OEM CATALOG</a>
      </div>
      <div className="scene-rail-section">
        <span className="technical">STATUS</span>
        {feedTime && (
          <span className={`feed-pill${statusFeed?.stale ? ' is-stale' : ''}`} title={t("设备状态来自服务端 /api/v1/sites/{siteId}/equipment-status")}>
            <i />
            {statusFeed?.stale ? 'CACHE' : 'LIVE'} {feedTime}
          </span>
        )}
      </div>
      <div className="scene-state-filter">
        <button
          type="button"
          data-state="all"
          className={`scene-state-filter-item${stateFilter === 'all' ? ' active' : ''}`}
          onClick={() => setStateFilter('all')}
        >
          <i style={{ background: '#7b91a8' }} />{t("全部")}<span>{FAB_LAYOUT.length}</span>
        </button>
        {(Object.keys(FAB_TOOL_STATE_META) as FabToolState[]).map((state) => (
          <button
            type="button"
            key={state}
            data-state={state}
            className={`scene-state-filter-item${stateFilter === state ? ' active' : ''}`}
            onClick={() => setStateFilter(state)}
          >
            <i style={{ background: FAB_TOOL_STATE_META[state].color }} />
            {t(FAB_TOOL_STATE_META[state].label)}
            <span>{stateCounts[state]}</span>
          </button>
        ))}
      </div>
      <div className="scene-rail-section">
        <span className="technical">EQUIPMENT</span>
        <span className="rail-count">{FAB_LAYOUT.length}</span>
      </div>
      <input
        className="scene-rail-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("搜索厂商 / 型号 / 工艺")}
        aria-label={t("搜索设备")}
      />
      <select
        className="scene-rail-select"
        value={categoryFilter}
        onChange={(event) => setCategoryFilter(event.target.value as 'all' | FabToolCategory)}
        aria-label={t("工艺筛选")}
      >
        <option value="all">{t("全部工艺 ·")}{FAB_LAYOUT.length}</option>
        {categoryCounts.map(([category, count]) => (
          <option key={category} value={category}>
            {t(TOOL_CATEGORY_LABELS[category] ?? category)} · {count}
          </option>
        ))}
      </select>
      <div className="scene-tool-list">
        {filtered.map(({ tool, index }) => (
          <button
            type="button"
            key={tool.x + '-' + tool.z}
            className={'scene-tool-list-item' + (selectedToolIndex === index ? ' active' : '')}
            onClick={() => onSelectTool(index)}
          >
            <span className="tool-card-top">
              <i className="tool-state-dot" style={{ background: FAB_TOOL_STATE_META[toolStates[index]].color }} />
              <span className="tool-card-index">{String(index + 1).padStart(3, '0')}</span>
              <span className="tool-card-category">{t(TOOL_CATEGORY_LABELS[tool.category] ?? tool.category)}</span>
              <span className="tool-card-state" style={{ color: FAB_TOOL_STATE_META[toolStates[index]].color }}>
                {t(FAB_TOOL_STATE_META[toolStates[index]].label)}
              </span>
            </span>
            <span className="tool-card-model">{tool.model}</span>
            <span className="tool-card-meta">
              {tool.vendor} · {tool.width.toFixed(1)}×{tool.depth.toFixed(1)} m
            </span>
          </button>
        ))}
        {!filtered.length && <div className="scene-tool-list-empty">{t("无匹配设备")}</div>}
      </div>
      <div className="scene-rail-foot">{t("单 FAB 视图 ·")}{filtered.length} / {FAB_LAYOUT.length}{t("台设备")}</div>
    </aside>
  );
}
