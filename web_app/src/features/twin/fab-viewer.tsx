import { useTwinLocale } from './twin-i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useRuntimeStore, runtimeActions } from '../../state/runtimeStore';
import { createCoalescedDispatcher } from '../../state/telemetry-buffer';
import type { FabDto, SiteDto } from '../../contracts';
import { bindViewerZoom } from '../../viewer-zoom';
import { SceneFacade, type AmhsStats, type CutAxis, type HoveredTool, type PickedTool, type SceneLayer, type SceneViewPreset, type XRayFilter } from '../../fab-scene';
import { FAB_TOOL_STATE_META, type FabToolState } from '../../fab-layout';

export interface FabViewportProps {
  site: SiteDto;
  fab: FabDto;
  toolStates: readonly FabToolState[];
  onToolChange?: (tool?: PickedTool) => void;
  layers: Record<SceneLayer, boolean>;
  explodeFactor: number;
  explodeMode?: boolean;
  basement: boolean;
  dual: boolean;
  onStatusChange?: (status: string) => void;
  onAmhsStatsChange?: (stats: AmhsStats) => void;
  /** Optional frame-loop source read directly from the store without a React prop pass. */
  getToolStates?: () => readonly FabToolState[];
}

export interface FabViewportHandle {
  setView(preset: SceneViewPreset): void;
  setCameraPose(position: readonly [number, number, number], target: readonly [number, number, number], durationMs: number): void;
  getCameraPose(): { position: readonly [number, number, number]; target: readonly [number, number, number] } | null;
  zoom(deltaY: number): void;
  resize(): void;
  reload(): void;
  selectTool(index: number, focus?: boolean): void;
  clearSelection(): void;
  setLayer(layer: SceneLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setTour(active: boolean): void;
  setExplodeFactor(factor: number, modeActive?: boolean): void;
  setBasement(active: boolean): void;
  setDual(active: boolean): void;
  setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void;
  setXRayFilter(filter: XRayFilter | null): void;
  setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void;
  setWaferTrail(points: readonly (readonly [number, number, number])[]): void;
  focusPatrol(): void;
  setLanguage(language: 'zh' | 'en'): void;
}

export const FabViewport = forwardRef<FabViewportHandle, FabViewportProps>(function FabViewport(
  { site, fab, toolStates, onToolChange, layers, explodeFactor, explodeMode, basement, dual, onStatusChange, onAmhsStatsChange, getToolStates },
  ref,
) {
  const { t } = useTwinLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const facade = useRef<SceneFacade | undefined>(undefined);
  const status = useRuntimeStore(state => state.viewer.status);
  const generation = useRuntimeStore(state => state.viewer.generation);
  const hoveredTool = useRuntimeStore(state => state.viewer.hover);
  const ready = status.startsWith('WebGPU ·') || status.startsWith('WebGPU 设备');

  useEffect(() => {
    const root = surface.current;
    if (root) return bindViewerZoom(root, (delta) => facade.current?.zoom(delta));
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const controller = new AbortController();
    const epoch = crypto.randomUUID();
    runtimeActions.viewerMounted(epoch);
    const hoverBatcher = createCoalescedDispatcher<HoveredTool | undefined>(hover => {
      runtimeActions.viewerHoverReceived({ epoch, hover });
    }, 50);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      hoverBatcher.cancel();
      facade.current?.clearSelection();
      runtimeActions.viewerHoverCleared();
    };
    window.addEventListener('keydown', onKeyDown);
    let scene: SceneFacade | undefined;
    void import('../../lite-backend')
      .then(({ createLiteBackend }) => {
        if (controller.signal.aborted) return;
        scene = new SceneFacade(createLiteBackend());
        facade.current = scene;
        onToolChange?.(undefined);
        return scene.mount(
          element,
          [{ fabId: fab.fabId, code: fab.code, position: [0, 0, 0] }],
          (value) => {
            if (controller.signal.aborted) return;
            runtimeActions.viewerStatusReceived({ epoch, status: value });
            onStatusChange?.(value);
          },
          (tool) => { onToolChange?.(tool ?? undefined); },
          (stats) => { onAmhsStatsChange?.(stats); },
          (hover) => hoverBatcher.push(hover ?? undefined),
          getToolStates,
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const status = error instanceof Error ? error.message : t("场景初始化失败");
          runtimeActions.viewerStatusReceived({ epoch, status });
          onStatusChange?.(status);
        }
      });
    return () => {
      controller.abort();
      hoverBatcher.cancel();
      window.removeEventListener('keydown', onKeyDown);
      runtimeActions.viewerUnmounted(epoch);
      if (facade.current === scene) facade.current = undefined;
      scene?.dispose();
    };
  }, [site.siteId, fab.fabId, generation]);

  useImperativeHandle(
    ref,
    () => ({
      setView: (preset) => facade.current?.setView(preset),
      setCameraPose: (position, target, durationMs) => facade.current?.setCameraPose(position, target, durationMs),
      getCameraPose: () => facade.current?.getCameraPose() ?? null,
      zoom: (deltaY) => facade.current?.zoom(deltaY),
      resize: () => facade.current?.resize(),
      reload: () => { runtimeActions.viewerReloadRequested(); },
      selectTool: (index, focus) => facade.current?.selectTool(index, focus),
      clearSelection: () => facade.current?.clearSelection(),
      setLayer: (layer, visible) => facade.current?.setLayer(layer, visible),
      setToolState: (index, state) => facade.current?.setToolState(index, state),
      setTour: (active) => facade.current?.setTour(active),
      setExplodeFactor: (factor, modeActive) => facade.current?.setExplodeFactor(factor, modeActive),
      setBasement: (active) => facade.current?.setBasement(active),
      setDual: (active) => facade.current?.setDual(active),
      setCutPlane: (active, axis, position, invert) => facade.current?.setCutPlane(active, axis, position, invert),
      setXRayFilter: (filter) => facade.current?.setXRayFilter(filter),
      setWaferPoint: (x, y, z, visible, focus, rotationY) => facade.current?.setWaferPoint(x, y, z, visible, focus, rotationY),
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
    facade.current?.setExplodeFactor(explodeFactor, explodeMode);
  }, [explodeFactor, explodeMode, ready]);
  useEffect(() => { if (ready) facade.current?.setBasement(basement); }, [basement, ready]);
  useEffect(() => { if (ready) facade.current?.setDual(dual); }, [dual, ready]);
  const hovered = hoveredTool?.tool;
  return (
    <div ref={surface} className="scene twin-canvas">
      <canvas ref={canvas} aria-label={t("FAB WebGPU 场景")} />
      {hovered && <div className="twin-hovercard" style={{ left: hoveredTool.x + 12, top: hoveredTool.y + 12 }}>
        <strong>{hovered.vendor} {hovered.model}</strong>
        <span>{t(FAB_TOOL_STATE_META[toolStates[hovered.index] ?? hovered.state].label)} · #{hovered.index + 1}</span>
      </div>}
      {!ready && <div className="twin-render-status" role="status">{status}<button type="button" onClick={() => runtimeActions.viewerReloadRequested()}>{t("重新加载")}</button></div>}
    </div>
  );
});
