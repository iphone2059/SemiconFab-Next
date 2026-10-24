import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from 'react';
import type { CatalogEntryDto, FabDto, SiteDto } from './contracts';
import { FabToolInspector, matchToolCatalog } from './fab-tool-inspector';
import { ApiClient } from './api-client';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus } from './equipment-status';
import { SceneFacade, type AmhsStats, type HoveredTool, type PickedTool, type SceneLayer } from './fab-scene';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolCategory, type FabToolState } from './fab-layout';
import { Panel } from './ui';

type ViewMode = 'iso' | 'top';

function Glyph({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const IsoIcon = () => (
  <Glyph>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5" />
    <path d="M12 12v9" />
  </Glyph>
);

const TopIcon = () => (
  <Glyph>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="m9 11 3 3 3-3" />
  </Glyph>
);

const ResetIcon = () => (
  <Glyph>
    <path d="M4 10a8.4 8.4 0 1 1 2.2 8.3" />
    <path d="M4 4v6h6" />
  </Glyph>
);

const ExpandIcon = () => (
  <Glyph>
    <path d="M4 9V4h5" />
    <path d="M20 9V4h-5" />
    <path d="M4 15v5h5" />
    <path d="M20 15v5h-5" />
  </Glyph>
);

const CollapseIcon = () => (
  <Glyph>
    <path d="M9 4v5H4" />
    <path d="M15 4v5h5" />
    <path d="M9 20v-5H4" />
    <path d="M15 20v-5h5" />
  </Glyph>
);

const ReloadIcon = () => (
  <Glyph>
    <path d="M20 11a8 8 0 1 0-2.35 5.65" />
    <path d="M20 4v7h-7" />
  </Glyph>
);

type SceneView = 'iso' | 'top' | 'reset';

export interface SiteSceneProps {
  site: SiteDto;
  fab: FabDto;
  expanded: boolean;
  overlay?: ReactNode;
  toolStates: readonly FabToolState[];
  onToolChange?: (tool?: PickedTool) => void;
  layers: Record<SceneLayer, boolean>;
  onToggleLayer: (layer: SceneLayer) => void;
  touring: boolean;
  onToggleTour: () => void;
  exploded: boolean;
  onToggleExploded: () => void;
  basement: boolean;
  onToggleBasement: () => void;
}

export interface SiteSceneHandle {
  setView(preset: SceneView): void;
  zoom(deltaY: number): void;
  resize(): void;
  reload(): void;
  selectTool(index: number, focus?: boolean): void;
  setLayer(layer: SceneLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setTour(active: boolean): void;
  setExploded(active: boolean): void;
  setBasement(active: boolean): void;
}

const ZONE_LEGEND = [
  { label: '光刻区', color: '#d4a72c' },
  { label: '刻蚀区', color: '#c26b6b' },
  { label: '薄膜区', color: '#d68a4a' },
  { label: 'Cu 区', color: '#a98467' },
  { label: '注入区', color: '#8b7bb5' },
  { label: '扩散区', color: '#5c9b78' },
  { label: 'CMP / 清洗', color: '#4f9b9b' },
  { label: '量测区', color: '#5b82b5' },
  { label: '封装测试', color: '#b06c96' },
  { label: 'Subfab', color: '#4f6fa8' },
] as const;

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

function ToolCard({ tool, onClose, onFocus }: { tool: PickedTool; onClose: () => void; onFocus: () => void }) {
  const [entry, setEntry] = useState<CatalogEntryDto>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setEntry(undefined);
    setLoading(true);
    void new ApiClient().catalog({ q: tool.model }, controller.signal)
      .then(page => { if (!controller.signal.aborted) setEntry(matchToolCatalog(tool, page.items)); })
      .catch(() => { /* The scene and its real state remain available without OEM data. */ })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tool.vendor, tool.model]);
  return <FabToolInspector tool={tool} entry={entry && matchToolCatalog(tool, [entry])} loading={loading} categoryLabel={TOOL_CATEGORY_LABELS[tool.category]} onClose={onClose} onFocus={onFocus} />;
}

export const SiteScene = forwardRef<SiteSceneHandle, SiteSceneProps>(function SiteScene(
  { site, fab, expanded, overlay, toolStates, onToolChange, layers, onToggleLayer, touring, onToggleTour, exploded, onToggleExploded, basement, onToggleBasement },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const facade = useRef<SceneFacade | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('准备 WebGPU 视图…');
  const [generation, setGeneration] = useState(0);
  const [selectedTool, setSelectedTool] = useState<PickedTool>();
  const [amhsStats, setAmhsStats] = useState<AmhsStats>();
  const [hoveredTool, setHoveredTool] = useState<HoveredTool>();

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
            setReady(value.startsWith('WebGPU ·') || value.startsWith('WebGPU 设备'));
          },
          (tool) => {
            setSelectedTool(tool ?? undefined);
            onToolChange?.(tool ?? undefined);
          },
          (stats) => setAmhsStats(stats),
          (hover) => setHoveredTool(hover ?? undefined),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReady(false);
          setStatus(error instanceof Error ? error.message : '场景初始化失败');
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
      zoom: (deltaY) => facade.current?.zoom(deltaY),
      resize: () => facade.current?.resize(),
      reload: () => { setReady(false); setStatus('准备 WebGPU 视图…'); setGeneration((value) => value + 1); },
      selectTool: (index, focus) => facade.current?.selectTool(index, focus),
      setLayer: (layer, visible) => facade.current?.setLayer(layer, visible),
      setToolState: (index, state) => facade.current?.setToolState(index, state),
      setTour: (active) => facade.current?.setTour(active),
      setExploded: (active) => facade.current?.setExploded(active),
      setBasement: (active) => facade.current?.setBasement(active),
    }),
    [],
  );

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => facade.current?.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

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
  useEffect(() => { if (ready) facade.current?.setExploded(exploded); }, [exploded, ready]);
  useEffect(() => { if (ready) facade.current?.setBasement(basement); }, [basement, ready]);
  useEffect(() => { if (ready) facade.current?.setTour(touring); }, [touring, ready]);
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

  const failed = /失败|无法|错误|不满足|丢失/.test(status);
  const runningTools = toolStates.filter((state) => state === 'running').length;
  const downTools = toolStates.filter((state) => state === 'down').length;
  const utilization = (runningTools / FAB_LAYOUT.length) * 100;
  return (
    <div className={`scene${expanded ? ' scene-expanded' : ''}`}>
      <canvas ref={canvas} aria-label="FAB 基地估算占位几何" />
      <div className="scene-top">
        <div className="scene-live">
          <i className={`scene-dot${ready ? ' is-ready' : failed ? ' is-error' : ''}`} />
          <span className="technical">SITE DIGITAL VIEW</span>
        </div>
        <div className="scene-tags">
          <span className="scene-tag">
            {site.code} / {fab.code}
          </span>
          <span className="scene-tag">单 FAB 视图</span>
          <span className="scene-tag scene-util">UTIL {utilization.toFixed(1)}%</span>
          <span className={`scene-tag scene-alarm${downTools > 0 ? ' has-alarm' : ''}`}>故障 {downTools}</span>
          <span className="scene-tag">米 · 右手系 · +Y UP</span>
        </div>
      </div>
      <div className="scene-toolbar" role="toolbar" aria-label="场景工具栏">
        <span className="technical">MODE</span>
        <button
          type="button"
          className={`scene-mode-chip${!basement && !exploded ? ' active' : ''}`}
          aria-pressed={!basement && !exploded}
          onClick={() => { if (exploded) onToggleExploded(); if (basement) onToggleBasement(); }}
        >
          3D
        </button>
        <button
          type="button"
          className={`scene-mode-chip${basement ? ' active' : ''}`}
          aria-pressed={basement}
          onClick={onToggleBasement}
        >
          B1
        </button>
        <button
          type="button"
          className={`scene-mode-chip${exploded ? ' active' : ''}`}
          aria-pressed={exploded}
          onClick={onToggleExploded}
        >
          Explode
        </button>
        <span className="scene-toolbar-divider" aria-hidden="true" />
        <span className="technical">LAYERS</span>
        <button
          type="button"
          className={`scene-layer-toggle${layers.amhs ? ' active' : ''}`}
          aria-pressed={layers.amhs}
          onClick={() => onToggleLayer('amhs')}
        >
          AMHS
        </button>
        <button
          type="button"
          className={`scene-layer-toggle${layers.ceiling ? ' active' : ''}`}
          aria-pressed={layers.ceiling}
          onClick={() => onToggleLayer('ceiling')}
        >
          FFU
        </button>
        <button
          type="button"
          className={`scene-layer-toggle${layers.subfab ? ' active' : ''}`}
          aria-pressed={layers.subfab}
          onClick={() => onToggleLayer('subfab')}
        >
          Subfab
        </button>
        <button
          type="button"
          className={`scene-layer-toggle${layers.heatmap ? ' active' : ''}`}
          aria-pressed={!!layers.heatmap}
          onClick={() => onToggleLayer('heatmap')}
        >
          Heatmap
        </button>
        <button
          type="button"
          className={`scene-layer-toggle${layers.airflow ? ' active' : ''}`}
          aria-pressed={!!layers.airflow}
          onClick={() => onToggleLayer('airflow')}
        >
          Airflow
        </button>
        <button
          type="button"
          className={`scene-layer-toggle${layers.xray ? ' active' : ''}`}
          aria-pressed={!!layers.xray}
          onClick={() => onToggleLayer('xray')}
        >
          X-Ray
        </button>
        <span className="scene-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={`scene-tour-toggle${touring ? ' active' : ''}`}
          aria-pressed={touring}
          onClick={onToggleTour}
        >
          ▶ Tour
        </button>
      </div>
      <div className="scene-zone-legend" aria-label="工艺分区图例">
        {ZONE_LEGEND.map((zone) => (
          <span className="scene-zone-chip" key={zone.label}>
            <i style={{ background: zone.color }} />
            {zone.label}
          </span>
        ))}
      </div>
      {amhsStats && (
        <div className="scene-amhs-hud" aria-live="polite">
          <span className="technical">AMHS · OHT</span>
          <strong>
            {String(amhsStats.active).padStart(2, '0')}/{amhsStats.total}
          </strong>
          <span>排队 {amhsStats.queued}</span>
          <span>完成 {amhsStats.completed}</span>
          {amhsStats.avgDelivery !== null && <span>均 {amhsStats.avgDelivery.toFixed(1)}s</span>}
        </div>
      )}
      {hoveredTool && (
        <div className="scene-hovercard" style={{ left: hoveredTool.x + 12, top: hoveredTool.y + 12 }} role="tooltip">
          <strong>{hoveredTool.tool.vendor}</strong>
          <span>{hoveredTool.tool.model}</span>
          <em>
            {TOOL_CATEGORY_LABELS[hoveredTool.tool.category] ?? hoveredTool.tool.category} ·{' '}
            {FAB_TOOL_STATE_META[toolStates[hoveredTool.tool.index] ?? hoveredTool.tool.state].label}
          </em>
        </div>
      )}
      {overlay}
      {selectedTool && (
        <ToolCard
          tool={{ ...selectedTool, state: toolStates[selectedTool.index] ?? selectedTool.state }}
          onFocus={() => facade.current?.selectTool(selectedTool.index, true)}
          onClose={() => {
            facade.current?.clearSelection();
            setSelectedTool(undefined);
            onToolChange?.(undefined);
          }}
        />
      )}
      <div className="scene-caption">
        <span
          className={`scene-status${ready ? ' is-ready' : failed ? ' is-error' : ''}`}
          title={status}
          aria-live="polite"
        >
          <i />
          <span>{status}</span>
        </span>
        <span className="scene-hint">点击选中 · 双击定位 · 拖动旋转 · 滚轮 / 双指缩放</span>
        <button
          type="button"
          className="ghost scene-reload"
          onClick={() => { setReady(false); setStatus('准备 WebGPU 视图…'); setGeneration((value) => value + 1); }}
        >
          <ReloadIcon />
          重新加载
        </button>
      </div>
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
        (TOOL_CATEGORY_LABELS[tool.category] ?? tool.category).toLowerCase().includes(value)),
    );
  }, [query, stateFilter, categoryFilter, toolStates]);
  const feedTime = statusFeed
    ? new Date(statusFeed.updatedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  return (
    <aside className="scene-rail" aria-label="FAB 设备清单">
      <div className="scene-rail-head">
        <span className="technical">FAB EQUIPMENT</span>
        <span className="rail-count">{FAB_LAYOUT.length}</span>
      </div>
      <div className="scene-rail-tabs" role="tablist" aria-label="设备目录">
        <button type="button" role="tab" aria-selected="true" className="active">FAB TOOLS <span>{FAB_LAYOUT.length}</span></button>
        <a role="tab" aria-selected="false" href="/catalog">OEM CATALOG</a>
      </div>
      <div className="scene-rail-section">
        <span className="technical">STATUS</span>
        {feedTime && (
          <span className={`feed-pill${statusFeed?.stale ? ' is-stale' : ''}`} title="设备状态来自服务端 /api/v1/sites/{siteId}/equipment-status">
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
          <i style={{ background: '#7b91a8' }} />
          全部
          <span>{FAB_LAYOUT.length}</span>
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
            {FAB_TOOL_STATE_META[state].label}
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
        placeholder="搜索厂商 / 型号 / 工艺"
        aria-label="搜索设备"
      />
      <select
        className="scene-rail-select"
        value={categoryFilter}
        onChange={(event) => setCategoryFilter(event.target.value as 'all' | FabToolCategory)}
        aria-label="工艺筛选"
      >
        <option value="all">全部工艺 · {FAB_LAYOUT.length}</option>
        {categoryCounts.map(([category, count]) => (
          <option key={category} value={category}>
            {TOOL_CATEGORY_LABELS[category] ?? category} · {count}
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
              <span className="tool-card-category">{TOOL_CATEGORY_LABELS[tool.category] ?? tool.category}</span>
              <span className="tool-card-state" style={{ color: FAB_TOOL_STATE_META[toolStates[index]].color }}>
                {FAB_TOOL_STATE_META[toolStates[index]].label}
              </span>
            </span>
            <span className="tool-card-model">{tool.model}</span>
            <span className="tool-card-meta">
              {tool.vendor} · {tool.width.toFixed(1)}×{tool.depth.toFixed(1)} m
            </span>
          </button>
        ))}
        {!filtered.length && <div className="scene-tool-list-empty">无匹配设备</div>}
      </div>
      <div className="scene-rail-foot">
        单 FAB 视图 · {filtered.length} / {FAB_LAYOUT.length} 台设备
      </div>
    </aside>
  );
}

export function SitePreview({ site }: { site: SiteDto }) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<ViewMode>('iso');
  const [touring, setTouring] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [basement, setBasement] = useState(false);
  const [selectedToolIndex, setSelectedToolIndex] = useState<number>();
  const [layers, setLayers] = useState<Record<SceneLayer, boolean>>({ amhs: true, ceiling: false, subfab: false, heatmap: false, airflow: false, xray: false });
  const [toolStates, setToolStates] = useState<FabToolState[]>(() => [...FAB_TOOL_STATES]);
  const [statusFeed, setStatusFeed] = useState<{ updatedAt: string; stale: boolean }>();
  useEffect(() => {
    const api = new ApiClient();
    const controller = new AbortController();
    const applySnapshot = createOrderedEquipmentStatusConsumer(
      site.siteId, FAB_LAYOUT.length, (snapshot) => {
        const next = FAB_LAYOUT.map((_, index): FabToolState => {
          const state = snapshot.tools[index]?.state;
          return state === 'running' || state === 'idle' || state === 'down' || state === 'maint'
            ? state
            : 'idle';
        });
        setToolStates(next);
        setStatusFeed({ updatedAt: snapshot.generatedAt, stale: false });
        next.forEach((state, index) => scene.current?.setToolState(index, state));
      }, () => setStatusFeed(current => current ? { ...current, stale: true } : current),
    );
    const load = async () => {
      try {
        const snapshot = await api.equipmentStatus(site.siteId, controller.signal);
        if (!controller.signal.aborted) applySnapshot(snapshot);
      } catch {
        if (!controller.signal.aborted) {
          setStatusFeed((current) => current ? { ...current, stale: true } : current);
        }
      }
    };
    void load();
    const timer = window.setInterval(load, 12000);
    const source = new EventSource(`/api/v1/sites/${encodeURIComponent(site.siteId)}/equipment-status/stream`);
    watchEquipmentStatus(source, site.siteId, applySnapshot,
      () => setStatusFeed(current => current && !current.stale ? { ...current, stale: true } : current), controller.signal);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [site.siteId]);
  const selectedFab = site.fabs[0];
  const toggleLayer = (layer: SceneLayer) => {
    setLayers((current) => {
      const visible = !current[layer];
      scene.current?.setLayer(layer, visible);
      return { ...current, [layer]: visible };
    });
  };
  const scene = useRef<SiteSceneHandle>(null);
  const root = useRef<HTMLElement>(null);
  const maximize = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const panel = root.current;
    if (!panel) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.target instanceof Element && event.target.closest('.scene-toolcard')) return;
      const inScene = event.target instanceof Element && event.target.closest('.scene') !== null;
      if (!event.ctrlKey && !inScene) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      scene.current?.zoom(event.deltaY * scale);
    };
    const blockGesture = (event: Event) => event.preventDefault();
    panel.addEventListener('wheel', onWheel, { passive: false });
    panel.addEventListener('gesturestart', blockGesture);
    panel.addEventListener('gesturechange', blockGesture);
    return () => {
      panel.removeEventListener('wheel', onWheel);
      panel.removeEventListener('gesturestart', blockGesture);
      panel.removeEventListener('gesturechange', blockGesture);
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('preview-open');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setExpanded(false);
        return;
      }
      if (event.key !== 'Tab' || !root.current) return;
      const focusable = Array.from(
        root.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const frame = window.requestAnimationFrame(() => {
      maximize.current?.focus();
      scene.current?.resize();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove('preview-open');
      maximize.current?.focus();
    };
  }, [expanded]);

  function applyView(next: 'iso' | 'top') {
    setView(next);
    setTouring(false);
    scene.current?.setTour(false);
    scene.current?.setView(next);
  }

  function resetView() {
    setView('iso');
    setTouring(false);
    scene.current?.setTour(false);
    scene.current?.setView('reset');
  }

  function toggleTour() {
    setTouring((current) => {
      const next = !current;
      scene.current?.setTour(next);
      return next;
    });
  }

  function openPreview() {
    const url = new URL(window.location.href);
    url.pathname = `${import.meta.env.BASE_URL}preview`.replace(/\/+/g, '/');
    url.search = new URLSearchParams({ siteId: site.siteId }).toString();
    url.hash = '';
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }

  const title = '在新标签页打开 FAB 预览';
  return (
    <>
      {expanded && <div className="preview-backdrop" aria-hidden="true" onClick={() => setExpanded(false)} />}
      <Panel
        title="基地空间概览"
        subtitle="单 FAB 清洁室视图；独立运行，不连接其他 FAB。"
        className={`site-preview${expanded ? ' is-maximized' : ''}`}
        containerRef={root}
        role={expanded ? 'dialog' : undefined}
        aria-modal={expanded ? true : undefined}
        aria-label={expanded ? '基地空间预览，已最大化' : undefined}
        actions={
          <div className="panel-actions">
            <div className="view-switch" role="group" aria-label="场景视图">
              <button
                type="button"
                className={`icon-button${view === 'iso' ? ' active' : ''}`}
                aria-pressed={view === 'iso'}
                title="等轴视图"
                aria-label="等轴视图"
                onClick={() => applyView('iso')}
              >
                <IsoIcon />
              </button>
              <button
                type="button"
                className={`icon-button${view === 'top' ? ' active' : ''}`}
                aria-pressed={view === 'top'}
                title="俯视视图"
                aria-label="俯视视图"
                onClick={() => applyView('top')}
              >
                <TopIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                title="放大"
                aria-label="放大视图"
                onClick={() => scene.current?.zoom(-120)}
              >
                +
              </button>
              <button
                type="button"
                className="icon-button"
                title="缩小"
                aria-label="缩小视图"
                onClick={() => scene.current?.zoom(120)}
              >
                −
              </button>
              <button
                type="button"
                className="icon-button"
                title="重置视角"
                aria-label="重置视角"
                onClick={resetView}
              >
                <ResetIcon />
              </button>
            </div>
            <span className="panel-action-divider" aria-hidden="true" />
            <button
              type="button"
              ref={maximize}
              className="icon-button icon-with-label"
              aria-label={title}
              title={title}
              onClick={openPreview}
            >
              <ExpandIcon />
              <span>新标签页</span>
            </button>
          </div>
        }
      >
        {selectedFab && (
          <SiteScene
            ref={scene}
            site={site}
            fab={selectedFab}
            expanded={expanded}
            toolStates={toolStates}
            onToolChange={(tool) => setSelectedToolIndex(tool?.index)}
            layers={layers}
            onToggleLayer={toggleLayer}
            touring={touring}
            onToggleTour={toggleTour}
            exploded={exploded}
            onToggleExploded={() => setExploded((current) => { const next = !current; scene.current?.setExploded(next); return next; })}
            basement={basement}
            onToggleBasement={() => setBasement((current) => { const next = !current; scene.current?.setBasement(next); return next; })}
            overlay={
              expanded ? (
                <FabRail
                  selectedToolIndex={selectedToolIndex}
                  onSelectTool={(index) => scene.current?.selectTool(index, false)}
                  toolStates={toolStates}
                  statusFeed={statusFeed}
                />
              ) : undefined
            }
          />
        )}
        <div className="scene-legend">
          <span>
            <i />
            估算加工设备
          </span>
          <span>单 FAB · SSE 设备状态</span>
          <span>
            {site.code} / {selectedFab?.code ?? '—'}
          </span>
        </div>
      </Panel>
    </>
  );
}
