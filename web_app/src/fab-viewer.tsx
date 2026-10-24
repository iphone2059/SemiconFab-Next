import { useTwinLocale } from './twin-i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FabDto, SiteDto } from './contracts';
import { bindViewerZoom } from './viewer-zoom';
import { SceneFacade, type AmhsStats, type CutAxis, type HoveredTool, type PickedTool, type SceneLayer, type SceneViewPreset, type XRayFilter } from './fab-scene';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, type FabToolState } from './fab-layout';

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
  /** Optional frame-loop source read directly from Redux without a React prop pass. */
  getToolStates?: () => readonly FabToolState[];
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
  focusPatrol(): void;
  setLanguage(language: 'zh' | 'en'): void;
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
  { site, fab, toolStates, onToolChange, layers, explodeFactor, basement, dual, onStatusChange, onAmhsStatsChange, getToolStates },
  ref,
) {
  const { t } = useTwinLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const facade = useRef<SceneFacade | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(t("准备 WebGPU 视图…"));
  const [generation, setGeneration] = useState(0);
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
        onToolChange?.(undefined);
        return scene.mount(
          element,
          [{ fabId: fab.fabId, code: fab.code, position: [0, 0, 0] }],
          (value) => {
            setStatus(value);
            onStatusChange?.(value);
            setReady(value.startsWith('WebGPU ·') || value.startsWith('WebGPU 设备'));
          },
          (tool) => { onToolChange?.(tool ?? undefined); },
          (stats) => { onAmhsStatsChange?.(stats); },
          (hover) => setHoveredTool(hover ?? undefined),
          getToolStates,
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
      focusPatrol: () => facade.current?.focusPatrol(),
      setLanguage: (language) => facade.current?.setLanguage(language),
    }),
    [],
  );

  useEffect(() => {
    facade.current?.clearSelection();
    onToolChange?.(undefined);
  }, [fab.fabId]);

  useEffect(() => {
    if (!ready || getToolStates) return;
    toolStates.forEach((state, index) => facade.current?.setToolState(index, state));
  }, [toolStates, ready, getToolStates]);

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
