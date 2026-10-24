import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from './api-client';
import type { SiteDto } from './contracts';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus } from './equipment-status';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { AmhsStats, PickedTool, SceneLayer } from './fab-scene';
import { FabRail, SiteScene, type SiteSceneHandle } from './site-preview';
type EntryMode = 'visitor' | 'engineer' | 'research';
type CameraView = 'iso' | 'top' | 'litho' | 'airshower';

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
  { layer: 'xray', label: 'X-Ray' },
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
  const [mode, setMode] = useState<EntryMode>('engineer');
  const [touring, setTouring] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [basement, setBasement] = useState(false);
  const [selected, setSelected] = useState<PickedTool>();
  const [status, setStatus] = useState('准备 WebGPU 视图…');
  const [amhs, setAmhs] = useState<AmhsStats>();
  const [railOpen, setRailOpen] = useState(true);

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
        setToolStates(next);
        setStatusFeed({ updatedAt: snapshot.generatedAt, stale: false });
        next.forEach((state, index) => scene.current?.setToolState(index, state));
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
  function setL1(): void {
    if (basement) { scene.current?.setBasement(false); setBasement(false); }
    if (exploded) { scene.current?.setExploded(false); setExploded(false); }
  }
  function setB1(): void {
    if (exploded) { scene.current?.setExploded(false); setExploded(false); }
    const next = !basement;
    scene.current?.setBasement(next);
    setBasement(next);
  }
  function toggleExploded(): void {
    if (basement) { scene.current?.setBasement(false); setBasement(false); }
    const next = !exploded;
    scene.current?.setExploded(next);
    setExploded(next);
  }
  function toggleTour(): void {
    const next = !touring;
    setTouring(next);
    scene.current?.setTour(next);
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
            <button type="button" className={!basement && !exploded ? 'active' : ''} onClick={setL1}>L1</button>
            <button type="button" className={basement ? 'active' : ''} onClick={setB1}>B1</button>
            <button type="button" className={exploded ? 'active' : ''} onClick={toggleExploded}>Explode</button>
          </div>
          <div className="twin-cameras" role="group" aria-label="相机预设">
            <button type="button" className={view === 'iso' ? 'active' : ''} onClick={() => setCamera('iso')}>ISO</button>
            <button type="button" className={view === 'top' ? 'active' : ''} onClick={() => setCamera('top')}>Top</button>
            <button type="button" onClick={() => setCamera('litho')}>Litho</button>
            <button type="button" onClick={() => setCamera('airshower')}>Airlock</button>
          </div>
          <button type="button" className={`twin-tour${touring ? ' active' : ''}`} aria-pressed={touring} onClick={toggleTour}>▶ Tour</button>
        </div>
        <div className="twin-topright">
          <span className={`twin-feed${statusFeed?.stale ? ' is-stale' : ''}`}><i />{statusFeed?.stale ? 'CACHE' : 'LIVE'}</span>
          <a href="/">工作台</a>
        </div>
      </header>

      <div className="twin-kpis">
        <span><b>{utilization.toFixed(1)}%</b> UTIL</span>
        <span><b>{FAB_LAYOUT.length}</b> TOOLS</span>
        <span><b>{String(amhs?.active ?? 0).padStart(2, '0')}/{amhs?.total ?? 24}</b> OHT</span>
        <span><b>{stateCounts.down}</b> ALARM</span>
      </div>

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
          touring={touring}
          onToggleTour={toggleTour}
          exploded={exploded}
          onToggleExploded={toggleExploded}
          basement={basement}
          onToggleBasement={setB1}
        />

        {railOpen && mode !== 'visitor' && (
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
        {!railOpen && mode !== 'visitor' && <button type="button" className="twin-rail-open" onClick={() => setRailOpen(true)}>设备清单 ›</button>}

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
          </aside>
        )}

        {mode === 'research' && (
          <div className="twin-research-note" role="status">
            <strong>Research 回放尚未接入</strong>
            <span>当前只显示实时合成状态；JSONL 时间轴将在 TWIN-11 接入，未用模拟数据冒充回放。</span>
          </div>
        )}

        <div className="twin-bottom">
          <span className="twin-status"><i className={status.startsWith('WebGPU') ? 'ok' : ''} />{status}</span>
          <span>FAB-01 · 单 FAB</span>
          <span>AMHS OHT {String(amhs?.active ?? 0).padStart(2, '0')}/{amhs?.total ?? 24}</span>
          <span>{stateCounts.running} RUN · {stateCounts.idle} IDLE · {stateCounts.down} DOWN · {stateCounts.maint} MAINT</span>
        </div>

        <div className="twin-layers" aria-label="图层">
          {LAYER_LABELS.map(({ layer, label }) => (
            <button type="button" key={layer} className={layers[layer] ? 'active' : ''} aria-pressed={!!layers[layer]} onClick={() => toggleLayer(layer)}>{label}</button>
          ))}
        </div>
      </div>
    </main>
  );
}
