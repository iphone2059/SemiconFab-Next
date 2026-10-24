import { useEffect, useRef, useState } from 'react';
import { ApiClient } from './api-client';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus } from './equipment-status';
import type { SiteDto } from './contracts';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { SceneLayer } from './fab-scene';
import { FabRail, SiteScene, type SiteSceneHandle } from './site-preview';

export function PreviewPage() {
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
  const [view, setView] = useState<'iso' | 'top'>('iso');
  const [touring, setTouring] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [basement, setBasement] = useState(false);
  const [selectedToolIndex, setSelectedToolIndex] = useState<number>();
  const scene = useRef<SiteSceneHandle>(null);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const api = new ApiClient();
    void api.sites(controller.signal)
      .then((sites) => {
        if (controller.signal.aborted) return;
        const wanted = new URL(location.href).searchParams.get('siteId');
        const next = wanted ? sites.find((value) => value.siteId === wanted) : sites[0];
        if (!next) throw new Error(wanted ? `指定的 FAB 站点不存在：${wanted}` : '没有可用的 FAB 站点');
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
      site.siteId, FAB_LAYOUT.length, (snapshot) => {
        const next = FAB_LAYOUT.map((_, index): FabToolState => {
          const state = snapshot.tools[index]?.state;
          return state === 'running' || state === 'idle' || state === 'down' || state === 'maint' ? state : 'idle';
        });
        setToolStates(next);
        setStatusFeed({ updatedAt: snapshot.generatedAt, stale: false });
      }, () => setStatusFeed(current => current ? { ...current, stale: true } : current),
    );
    void api.equipmentStatus(site.siteId, controller.signal)
      .then(snapshot => { if (!controller.signal.aborted) applySnapshot(snapshot); })
      .catch(() => {
        if (!controller.signal.aborted) setStatusFeed(current => current ? { ...current, stale: true } : current);
      });
    const source = new EventSource(`/api/v1/sites/${encodeURIComponent(site.siteId)}/equipment-status/stream`);
    watchEquipmentStatus(source, site.siteId, applySnapshot,
      () => setStatusFeed(current => current && !current.stale ? { ...current, stale: true } : current), controller.signal);
    return () => {
      controller.abort();
    };
  }, [site]);

  useEffect(() => {
    if (site) document.title = `${site.code} · FAB 预览`;
  }, [site]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === '1') {
        scene.current?.setView('iso');
        setView('iso');
      } else if (event.key === '2') {
        scene.current?.setView('top');
        setView('top');
      } else if (event.key.toLowerCase() === 'r') {
        scene.current?.setView('reset');
        setView('iso');
      } else if (event.key.toLowerCase() === 't') {
        setTouring((current) => {
          const next = !current;
          scene.current?.setTour(next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const panel = root.current;
    if (!panel) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.target instanceof Element && event.target.closest('.scene-rail, .scene-toolcard')) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      if (event.target instanceof Element && event.target.closest('.scene')) {
        scene.current?.zoom(event.deltaY * scale);
      }
    };
    panel.addEventListener('wheel', onWheel, { passive: false });
    return () => panel.removeEventListener('wheel', onWheel);
  }, [site]);

  const fab = site?.fabs[0];
  const toggleTour = () => {
    setTouring((current) => {
      const next = !current;
      scene.current?.setTour(next);
      return next;
    });
  };
  const changeView = (next: 'iso' | 'top') => {
    setTouring(false);
    scene.current?.setTour(false);
    scene.current?.setView(next);
    setView(next);
  };
  const resetView = () => {
    setTouring(false);
    scene.current?.setTour(false);
    scene.current?.setView('reset');
    setView('iso');
  };
  const toggleLayer = (layer: SceneLayer) => {
    setLayers((current) => {
      const visible = !current[layer];
      scene.current?.setLayer(layer, visible);
      return { ...current, [layer]: visible };
    });
  };

  if (error) {
    return (
      <main className="standalone-preview standalone-message">
        <strong>FAB 预览无法加载</strong>
        <p>{error}</p>
        <a href="/">返回工作台</a>
      </main>
    );
  }
  if (!site || !fab) {
    return (
      <main className="standalone-preview standalone-message">
        <strong>正在加载 FAB…</strong>
        <p>连接本地站点服务</p>
      </main>
    );
  }

  return (
    <main className="standalone-preview" ref={root}>
      <header className="standalone-head">
        <div className="standalone-title">
          <span className="technical">FAB PREVIEW</span>
          <strong>{site.code} / {fab.code}</strong>
          <span>单 FAB 清洁室视图 · 1/2 视角 · R 重置 · T 巡游</span>
        </div>
        <div className="standalone-actions">
          <div className="view-switch" role="group" aria-label="场景视图">
            <button type="button" className={`icon-button${view === 'iso' ? ' active' : ''}`} aria-pressed={view === 'iso'} aria-label="等轴视图" onClick={() => changeView('iso')}>等轴</button>
            <button type="button" className={`icon-button${view === 'top' ? ' active' : ''}`} aria-pressed={view === 'top'} aria-label="俯视视图" onClick={() => changeView('top')}>俯视</button>
            <button type="button" className="icon-button" aria-label="放大视图" onClick={() => scene.current?.zoom(-120)}>+</button>
            <button type="button" className="icon-button" aria-label="缩小视图" onClick={() => scene.current?.zoom(120)}>−</button>
            <button type="button" className="icon-button" aria-label="重置视角" onClick={resetView}>重置</button>
          </div>
          <a className="ghost standalone-back" href="/">返回工作台</a>
        </div>
      </header>
      <div className="standalone-stage">
        <SiteScene
          ref={scene}
          site={site}
          fab={fab}
          expanded={false}
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
        />
        <FabRail
          selectedToolIndex={selectedToolIndex}
          onSelectTool={(index) => scene.current?.selectTool(index, false)}
          toolStates={toolStates}
          statusFeed={statusFeed}
        />
      </div>
    </main>
  );
}
