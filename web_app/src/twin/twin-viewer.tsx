import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useTwinLocale } from '@/twin/twin-i18n';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { viewerActions, viewerHoverAtom, viewerSessionAtom } from '@/state/viewer.atom';
import { createCoalescedDispatcher } from '@/lib/coalesced-dispatcher';
import type { FabDto, SiteDto } from '@/contracts/app-contracts';
import type {
  AmhsStats, HoveredTool, PickedTool, SceneCommands, SceneLayer, SceneLifecycleEvent, SceneMountOptions, ScenePort,
} from '@/contracts/scene.port';
import { FAB_TOOL_STATE_META, type FabToolState } from '@/domain/fab-layout';

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
  /** Match source OrbitControls start: stop guided camera ownership on user input. */
  onCameraInteraction?: () => void;
  /** Optional frame-loop source read directly from the store without a React prop pass. */
  getToolStates?: () => readonly FabToolState[];
}

/**
 * Imperative handle exposed to the twin page/controllers: the application ScenePort command
 * surface plus the viewer-level reload action. There are no optional capabilities here.
 */
export interface FabViewportHandle extends SceneCommands {
  reload(): void;
}

export const FabViewport = forwardRef<FabViewportHandle, FabViewportProps>(function FabViewport(
  { site, fab, toolStates, onToolChange, layers, explodeFactor, explodeMode, basement, dual, onStatusChange, onAmhsStatsChange, onCameraInteraction, getToolStates },
  ref,
) {
  const registry = useContext(RegistryContext);
  const { t } = useTwinLocale();
  // The GPU scene and its mount effect outlive individual renders. Route every
  // scene callback through a ref so the current props handlers are invoked
  // instead of the first render's closures (which capture a stale selection).
  const callbacks = useRef({ onToolChange, onStatusChange, onAmhsStatsChange });
  useLayoutEffect(() => { callbacks.current = { onToolChange, onStatusChange, onAmhsStatsChange }; }, [onToolChange, onStatusChange, onAmhsStatsChange]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const facade = useRef<ScenePort | undefined>(undefined);
  const frameSource = useRef({ getToolStates, toolStates });
  useLayoutEffect(() => { frameSource.current = { getToolStates, toolStates }; }, [getToolStates, toolStates]);
  // The GPU mount lifetime is deliberately longer than a language/FAB-code change;
  // read the latest translator/code through layout-updated refs instead of adding
  // them to the mount effect (a dependency change there would recreate the scene).
  const translator = useRef(t);
  useLayoutEffect(() => { translator.current = t; }, [t]);
  const fabCode = useRef(fab.code);
  useLayoutEffect(() => { fabCode.current = fab.code; }, [fab.code]);
  const status = useAtomValue(viewerSessionAtom, state => state.status);
  // Control flow uses the discrete lifecycle only; `status` is display copy for the HUD.
  const lifecycle = useAtomValue(viewerSessionAtom, state => state.lifecycle);
  const generation = useAtomValue(viewerSessionAtom, state => state.generation);
  const hoveredTool = useAtomValue(viewerHoverAtom);
  const ready = lifecycle === 'ready';

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const controller = new AbortController();
    // Stable viewer identity across the whole mount/abort lifetime; lifecycle events carry
    // display copy separately so the store can keep epoch-guarded control state.
    const epoch = crypto.randomUUID();
    viewerActions.viewerMounted(registry, epoch);
    const reportLifecycle = (event: SceneLifecycleEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === 'failed') failedReported = true;
      viewerActions.viewerLifecycleReceived(registry, { epoch, event });
      callbacks.current.onStatusChange?.(event.message);
    };
    let scene: ScenePort | undefined;
    let failedReported = false;
    const hoverBatcher = createCoalescedDispatcher<HoveredTool | undefined>(hover => {
      viewerActions.viewerHoverReceived(registry, { epoch, hover });
    }, 50);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      hoverBatcher.cancel();
      facade.current?.clearSelection();
      viewerActions.viewerHoverCleared(registry);
    };
    window.addEventListener('keydown', onKeyDown);
    const mountOptions = (): SceneMountOptions => ({
      viewerId: epoch,
      canvas: element,
      fabs: [{ fabId: fab.fabId, code: fabCode.current, position: [0, 0, 0] }],
      signal: controller.signal,
      callbacks: {
        onLifecycle: reportLifecycle,
        onToolPick: tool => { if (!controller.signal.aborted) callbacks.current.onToolChange?.(tool ?? undefined); },
        onAmhsStats: stats => { if (!controller.signal.aborted) callbacks.current.onAmhsStatsChange?.(stats); },
        onToolHover: hover => { if (!controller.signal.aborted) hoverBatcher.push(hover ?? undefined); },
        getToolStates: () => frameSource.current.getToolStates?.() ?? frameSource.current.toolStates,
      },
    });
    void import('@/rendering/lite-backend')
      .then(async ({ createLiteBackend }) => {
        if (controller.signal.aborted) return;
        scene = createLiteBackend();
        facade.current = scene;
        callbacks.current.onToolChange?.(undefined);
        const outcome = await scene.mount(mountOptions());
        // Defense in depth: a port implementation that reports a failed mount without a
        // lifecycle event must not leave the viewer silently initializing forever.
        if (outcome.status === 'failed' && !failedReported) {
          const error = outcome.error;
          reportLifecycle({ type: 'failed', message: error instanceof Error ? error.message : translator.current("场景初始化失败"), error });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          reportLifecycle({ type: 'failed', message: error instanceof Error ? error.message : translator.current("场景初始化失败"), error });
        }
      });
    return () => {
      controller.abort();
      hoverBatcher.cancel();
      window.removeEventListener('keydown', onKeyDown);
      viewerActions.viewerUnmounted(registry, epoch);
      if (facade.current === scene) facade.current = undefined;
      scene?.dispose();
    };
  }, [site.siteId, fab.fabId, generation, registry]);

  useImperativeHandle(
    ref,
    () => ({
      setView: (preset) => facade.current?.setView(preset),
      setCameraPose: (position, target, durationMs) => facade.current?.setCameraPose(position, target, durationMs),
      getCameraPose: () => facade.current?.getCameraPose() ?? null,
      zoom: (deltaY) => facade.current?.zoom(deltaY),
      resize: () => facade.current?.resize(),
      reload: () => { viewerActions.viewerReloadRequested(registry); },
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
    [registry],
  );

  useEffect(() => {
    facade.current?.clearSelection();
    callbacks.current.onToolChange?.(undefined);
  }, [fab.fabId, registry]);

  useEffect(() => {
    if (!ready || getToolStates) return;
    toolStates.forEach((state, index) => facade.current?.setToolState(index, state));
  }, [toolStates, ready, getToolStates, registry]);

  useEffect(() => {
    if (!ready) return;
    for (const [layer, visible] of Object.entries(layers)) facade.current?.setLayer(layer as SceneLayer, visible);
  }, [layers, ready, registry]);
  useEffect(() => {
    if (!ready) return;
    facade.current?.setExplodeFactor(explodeFactor, explodeMode);
  }, [explodeFactor, explodeMode, ready, registry]);
  useEffect(() => { if (ready) facade.current?.setBasement(basement); }, [basement, ready, registry]);
  useEffect(() => { if (ready) facade.current?.setDual(dual); }, [dual, ready, registry]);
  const hovered = hoveredTool?.tool;
  return (
    <div className="scene twin-canvas">
      <canvas ref={canvas} aria-label={t("FAB WebGPU 场景")}
        onPointerDownCapture={event => { if (event.pointerType !== "touch" && event.button >= 0 && event.button <= 2) onCameraInteraction?.(); }}
        onTouchStartCapture={() => onCameraInteraction?.()}
        onWheelCapture={() => onCameraInteraction?.()} />
      {hovered && <div className="twin-hovercard" style={{ left: hoveredTool.x + 12, top: hoveredTool.y + 12 }}>
        <strong>{hovered.vendor} {hovered.model}</strong>
        <span>{t(FAB_TOOL_STATE_META[toolStates[hovered.index] ?? hovered.state].label)} · #{hovered.index + 1}</span>
      </div>}
      {!ready && <div className="twin-render-status" role="status">{status}<button type="button" onClick={() => viewerActions.viewerReloadRequested(registry)}>{t("重新加载")}</button></div>}
    </div>
  );
});
