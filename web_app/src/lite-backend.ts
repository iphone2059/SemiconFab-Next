import type {
  AmhsStats, CutAxis, FabPlacement, HoveredTool, PickedTool, SceneBackend, SceneLayer, SceneViewPreset, XRayFilter,
} from './fab-scene';
import type { FabToolState } from './fab-layout';
import { createLiteRuntime, type LiteRuntime } from './rendering/lite/runtime';
import { createLiteWorld, type LiteWorld } from './rendering/lite/world';

type PerfBridge = { dispose(): void };

/**
 * Native Babylon Lite product backend. Owns the Lite runtime (GPU acquisition, first frame,
 * device-loss recovery) and the native product world; all product state enters through the
 * existing SceneBackend/SceneFacade interface, so React/Redux and the HUD stay unchanged.
 */
export function createLiteBackend(): SceneBackend {
  let runtime: LiteRuntime | undefined;
  let world: LiteWorld | undefined;
  let perf: PerfBridge | undefined;
  let disposed = false;
  let detachInput: (() => void) | undefined;
  const lifecycle = { backendId: crypto.randomUUID(), statuses: [] as string[], losses: 0, recoveries: 0, lastStatus: '' };
  // GPU validation errors observed by scenes that were torn down on device loss (diagnostics of
  // a replaced world would otherwise disappear with it).
  const retiredGpuErrors: string[] = [];

  // A08: the post-recovery replay is a one-shot initialization phase. Its timers are owned by the
  // backend so disposal or the next recovery can clear them, and each callback validates the
  // recovery generation + interaction version so it can never overwrite newer user input.
  // Both SceneBackend instructions and direct canvas input invalidate the replay.
  // The page reapplies presets only on a fresh viewport or a requested view change. The ambient
  // mode setters (setBasement/setDual) are re-applied by the same status effect, so they only
  // count as interaction when their value actually changes; otherwise a normal recovery would
  // cancel its own replay before the preserved pose/selection could be restored. The tracked
  // values mirror the world's mutual exclusivity (entering basement mode clears dual, v.v.).
  let interactionVersion = 0;
  let recoveryGeneration = 0;
  let replayTimers: number[] = [];
  let appliedBasement = false;
  let appliedDual = false;
  const cancelRecoveryReplay = () => {
    for (const timer of replayTimers) window.clearTimeout(timer);
    replayTimers = [];
  };
  const markUserInteraction = () => {
    interactionVersion += 1;
    cancelRecoveryReplay();
  };
  const scheduleRecoveryReplay = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      replayTimers = replayTimers.filter(handle => handle !== timer);
      callback();
    }, delay);
    replayTimers.push(timer);
  };

  function installPerf() {
    if (perf || !new URLSearchParams(location.search).has('perf')) return;
    const target = {
      // Same global/diagnostic shape as the legacy renderer's ?perf bridge so acceptance
      // tooling can A/B the two renderers on one machine with one script shape.
      getStats: () => {
        const perfState = world!.readPerf();
        return {
          fps: perfState.fps,
          frameTimeMs: perfState.fps > 0 ? 1000 / perfState.fps : 0,
          renderTimeMs: perfState.gpuFrameTimeMs,
          drawCalls: perfState.drawCalls,
          activeMeshes: perfState.meshes,
          frames: perfState.frames,
          heapBytes: (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? null,
        };
      },
      getCameraPose: () => world?.readPerf().cameraPose ?? null,
      getWorld: () => {
        const perfState = world!.readPerf();
        return {
          level: perfState.level, layers: perfState.layers, explodeFactor: perfState.explodeFactor,
          xrayFilter: perfState.xrayFilter, shadows: perfState.shadows, toolStates: perfState.toolStates,
        };
      },
      // Acceptance-only surface (?perf): live native diagnostics, lifecycle and device-loss probe.
      getDiagnostics: () => {
        const diagnostics = world?.readDiagnostics();
        return diagnostics ? { ...diagnostics, gpuErrors: [...retiredGpuErrors, ...diagnostics.gpuErrors] } : null;
      },
      getLifecycle: () => ({ ...lifecycle, statuses: [...lifecycle.statuses], status: world ? 'ready' : 'mounting' }),
      projectTool: (index: number) => world?.projectTool(index) ?? null,
      forceDeviceLoss: () => world?.forceDeviceLoss(),
      readStatus: () => lifecycle.lastStatus,
    };
    (window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__ = target;
    perf = {
      dispose() {
        if ((window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__ === target) {
          delete (window as Window & { __SEMICONFAB_PERF__?: typeof target }).__SEMICONFAB_PERF__;
        }
      },
    };
  }

  /**
   * Product device-loss strategy: Lite 1.36's in-place scene recovery rebuilds recorded material
   * groups and plugin UBOs after the X-Ray ShaderMaterial palette has been used, which the library
   * composition currently rejects. The product therefore rebuilds the native scene on the
   * replacement device (same canvas, same React/Redux state) and restores the user camera pose and
   * selection. Bounded fixtures still verify the native in-place recovery path directly.
   */
  return {
    async mount(canvas: HTMLCanvasElement, _fabs: readonly FabPlacement[], signal: AbortSignal,
      onStatus: (status: string) => void, onToolPick?: (tool: PickedTool | null) => void,
      onAmhsStats?: (stats: AmhsStats) => void, onToolHover?: (hover: HoveredTool | null) => void,
      getToolStates?: () => readonly FabToolState[]): Promise<void> {
      if (!window.isSecureContext || !navigator.gpu) {
        throw new Error('此终端无法使用 WebGPU。请使用支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 访问。');
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (signal.aborted || disposed) return;
      if (!adapter || adapter.limits.maxTextureDimension2D < 2048) {
        throw new Error('WebGPU adapter 或必要纹理限制不满足要求。');
      }
      const inputEvents = ['pointerdown', 'touchstart', 'wheel', 'dblclick'] as const;
      // Capture at the actual input boundary, before the native orbit/picking
      // handlers update world state. These paths never call backend setters.
      for (const event of inputEvents) canvas.addEventListener(event, markUserInteraction, { capture: true, passive: true });
      detachInput = () => {
        for (const event of inputEvents) canvas.removeEventListener(event, markUserInteraction, true);
      };
      signal.addEventListener('abort', () => { cancelRecoveryReplay(); detachInput?.(); detachInput = undefined; }, { once: true });
      let mountedWorld: LiteWorld | undefined;
      let restarting = false;
      // A loss during the replacement-scene build cannot start a second rebuild inline; queue it so
      // the replacement is never left on the in-place native recovery path this strategy avoids.
      let restartPending = false;
      let pendingPose: { position: readonly [number, number, number]; target: readonly [number, number, number] } | null = null;
      let pendingSelection: number | null = null;

      const report = (text: string) => { lifecycle.lastStatus = text; onStatus(text); };
      const statusHandler = (instance: LiteRuntime, status: string, error?: unknown) => {
        if (signal.aborted || disposed || instance !== runtime) return;
        lifecycle.statuses.push(status);
        if (status === 'initializing') report('正在初始化 WebGPU…');
        else if (status === 'lost') {
          lifecycle.losses += 1;
          report('GPU 设备已丢失，正在重新构建设备和静态场景。若失败，请重新加载视图。');
          // A new recovery supersedes any replay still pending from the previous one.
          recoveryGeneration += 1;
          cancelRecoveryReplay();
          // Capture user-visible state before the old scene is torn down.
          const previousDiagnostics = mountedWorld?.readDiagnostics();
          if (previousDiagnostics) retiredGpuErrors.push(...previousDiagnostics.gpuErrors);
          pendingPose = mountedWorld?.getCameraPose() ?? null;
          pendingSelection = previousDiagnostics?.selection.index ?? null;
          void restart(instance);
        } else if (status === 'ready') {
          if (lifecycle.losses > lifecycle.recoveries) lifecycle.recoveries += 1;
          report('WebGPU · 程序化 FAB · 121 台设备');
          installPerf();
          if (pendingPose) {
            const pose = pendingPose, selection = pendingSelection;
            pendingPose = null; pendingSelection = null;
            // The status-effect setView(preset) runs after this callback; re-apply once more after it
            // has settled so the preserved pose cannot lose the ordering race with the preset.
            // Both timers are cancelled when the user interacts, a newer recovery starts or the
            // backend is disposed, and the callback re-validates the captured identity.
            cancelRecoveryReplay();
            const scheduledWorld = world;
            const scheduledGeneration = recoveryGeneration;
            const scheduledVersion = interactionVersion;
            const applyRestoredState = () => {
              if (disposed || !world || world !== scheduledWorld
                || recoveryGeneration !== scheduledGeneration || interactionVersion !== scheduledVersion) return;
              world.setCameraPose(pose.position, pose.target, 0);
              if (selection !== null) world.selectTool(selection, false);
            };
            scheduleRecoveryReplay(applyRestoredState, 0);
            scheduleRecoveryReplay(applyRestoredState, 300);
          }
        } else if (status === 'failed') {
          console.error('[lite] runtime failed', error, (error as { cause?: { stack?: string } } | undefined)?.cause?.stack ?? '');
          report(error instanceof Error ? error.message : '场景初始化失败');
        }
      };

      const createInstance = (): LiteRuntime => {
        // The disposer must own this mount's world even after `world` is cleared for a restart.
        let ownedWorld: LiteWorld | undefined;
        let instance: LiteRuntime = undefined as unknown as LiteRuntime;
        instance = createLiteRuntime(canvas, {
          signal,
          async compose(scene, engine) {
            onStatus('正在加载原版设备模型…');
            ownedWorld = await createLiteWorld(scene, engine, canvas, {
              onToolPick, onToolHover, onAmhsStats, getToolStates,
            });
            mountedWorld = ownedWorld;
            world = ownedWorld;
            return () => { ownedWorld?.dispose(); ownedWorld = undefined; };
          },
          beforeStart: () => ownedWorld?.registerLabels() ?? Promise.resolve(),
          onStatus: (status, error) => statusHandler(instance, status, error),
        });
        runtime = instance;
        return instance;
      };

      const restart = async (instance: LiteRuntime) => {
        if (restarting) { restartPending = true; return; }
        restarting = true;
        // Keep the mount-owned world reachable: runtime release invokes the compose disposer which
        // disposes it (camera controls, overlay billboard scenes, label registrations).
        world = undefined;
        instance.dispose();
        await instance.whenReleased.catch(() => undefined);
        mountedWorld = undefined;
        if (signal.aborted || disposed) { restarting = false; return; }
        try {
          await createInstance().ready;
        } catch (restartError) {
          if (!signal.aborted && !disposed) report(restartError instanceof Error ? restartError.message : '场景恢复失败');
        } finally {
          restarting = false;
        }
        if (restartPending) {
          restartPending = false;
          const current = runtime;
          if (current && !disposed && !signal.aborted) void restart(current);
        }
      };

      const first = createInstance();
      try {
        await first.ready;
      } catch (error) {
        if (!signal.aborted && !disposed) throw error;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      detachInput?.(); detachInput = undefined;
      cancelRecoveryReplay();
      perf?.dispose(); perf = undefined;
      runtime?.dispose(); runtime = undefined;
      world = undefined;
    },
    setView(preset: SceneViewPreset, fabId?: string): void {
      if (disposed) return;
      markUserInteraction();
      world?.setView(preset, fabId);
    },
    setCameraPose(position, target, durationMs): void {
      if (disposed) return;
      markUserInteraction();
      world?.setCameraPose(position, target, durationMs);
    },
    getCameraPose() { return disposed ? null : world?.getCameraPose() ?? null; },
    zoom(deltaY: number): void {
      if (disposed) return;
      markUserInteraction();
      world?.zoom(deltaY);
    },
    resize(): void { if (!disposed) world?.resize(); },
    clearSelection(): void {
      if (disposed) return;
      markUserInteraction();
      world?.clearSelection();
    },
    selectTool(index: number, focus?: boolean): void {
      if (disposed) return;
      markUserInteraction();
      world?.selectTool(index, focus);
    },
    setLayer(layer: SceneLayer, visible: boolean): void { if (!disposed) world?.setLayer(layer, visible); },
    setToolState(index: number, state): void { if (!disposed) world?.setToolState(index, state); },
    setTour(active: boolean): void { if (!disposed) world?.setTour(active); },
    setExplodeFactor(factor: number, modeActive?: boolean): void { if (!disposed) world?.setExplodeFactor(factor, modeActive); },
    setBasement(active: boolean): void {
      if (disposed) return;
      // A genuine mode change supersedes a pending replay; the page's idempotent re-application
      // after a recovery must not. world.setBasement also clears dual mode and the selection.
      const changed = active !== appliedBasement;
      appliedBasement = active;
      if (active) appliedDual = false;
      if (changed) markUserInteraction();
      world?.setBasement(active);
    },
    setDual(active: boolean): void {
      if (disposed) return;
      const changed = active !== appliedDual;
      appliedDual = active;
      if (active) appliedBasement = false;
      if (changed) markUserInteraction();
      world?.setDual(active);
    },
    setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void {
      if (!disposed) world?.setCutPlane(active, axis, position, invert);
    },
    setXRayFilter(filter: XRayFilter | null): void { if (!disposed) world?.setXRayFilter(filter); },
    setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void {
      if (!disposed) world?.setWaferPoint(x, y, z, visible, focus, rotationY);
    },
    setWaferTrail(points: readonly (readonly [number, number, number])[]): void { if (!disposed) world?.setWaferTrail(points); },
    focusPatrol(): void {
      if (disposed) return;
      markUserInteraction();
      world?.focusPatrol();
    },
    setLanguage(language: 'zh' | 'en'): void { if (!disposed) world?.setLanguage(language); },
  };
}
