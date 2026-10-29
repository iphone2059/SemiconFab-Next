import type {
  CameraPose, CutAxis, SceneAcceptanceCapabilities, SceneLanguage, SceneLayer, SceneLifecycleEvent,
  SceneMountOptions, SceneMountOutcome, ScenePort, SceneViewPreset, XRayFilter,
} from '@/contracts/scene.port';
import { createLiteRuntime, type LiteRuntime } from '@/rendering/lite-runtime';
import { createLiteWorld, type LiteWorld } from '@/rendering/lite-world';

type PerfBridge = { dispose(): void };

/** The product port plus the explicit acceptance-only capability group this backend exposes. */
export interface LiteScenePort extends ScenePort {
  readonly acceptance: SceneAcceptanceCapabilities;
}

/**
 * Native Babylon Lite implementation of the application ScenePort. Owns the Lite runtime
 * (GPU acquisition, first frame, device-loss recovery), the native product world and the
 * single idempotent mount/dispose lifetime; product/React code only sees the port.
 */
export function createLiteBackend(): LiteScenePort {
  let runtime: LiteRuntime | undefined;
  let world: LiteWorld | undefined;
  let perf: PerfBridge | undefined;
  let disposed = false;
  let detachInput: (() => void) | undefined;
  let mountPromise: Promise<SceneMountOutcome> | undefined;
  let mountOptions: SceneMountOptions | undefined;
  let abortHandler: (() => void) | undefined;
  const lifecycle = { backendId: crypto.randomUUID(), statuses: [] as string[], losses: 0, recoveries: 0, lastStatus: '' };
  // GPU validation errors observed by scenes that were torn down on device loss (diagnostics of
  // a replaced world would otherwise disappear with it).
  const retiredGpuErrors: string[] = [];

  /** Only the active, non-cancelled mount may report to its readonly callbacks. */
  const active = (options: SceneMountOptions) => !disposed && !options.signal.aborted;
  function emit(options: SceneMountOptions, event: SceneLifecycleEvent): void {
    if (!active(options)) return;
    lifecycle.lastStatus = event.message;
    options.callbacks.onLifecycle(event);
  }

  // A08: the post-recovery replay is a one-shot initialization phase. Its timers are owned by the
  // backend so disposal or the next recovery can clear them, and each callback validates the
  // recovery generation + interaction version so it can never overwrite newer user input.
  // Both ScenePort instructions and direct canvas input invalidate the replay.
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
   *
   * The port lifetime is idempotent: mount() may be called repeatedly and resolves the same
   * outcome, dispose() may be called repeatedly, a cancelled/failed mount never reports lifecycle
   * events or callbacks afterwards, and a recoverable device loss reports 'recovering' -> 'ready'
   * for the same viewer identity.
   */
  const errorMessage = (error: unknown, fallback = '场景初始化失败'): string =>
    error instanceof Error ? error.message : fallback;

  const failMount = (options: SceneMountOptions, error: unknown, message?: string): SceneMountOutcome => {
    emit(options, { type: 'failed', message: message ?? errorMessage(error), error });
    dispose();
    return { status: 'failed', error };
  };

  async function mountScene(options: SceneMountOptions): Promise<SceneMountOutcome> {
    const { signal, canvas, callbacks } = options;
    if (disposed) return { status: 'cancelled' };
    if (signal.aborted) {
      // A mount cancelled before any device work still closes the port lifetime so no later
      // callback can observe a half-initialized viewer.
      dispose();
      return { status: 'cancelled' };
    }
    if (!window.isSecureContext || !navigator.gpu) {
      return failMount(options, new Error('此终端无法使用 WebGPU。请使用支持 WebGPU 的浏览器，并通过 HTTPS 或 localhost 访问。'));
    }
    // Aborting the mount disposes the whole port lifetime: no late GPU callback may reach the
    // page after the viewer React replaced this scene.
    abortHandler = () => { cancelRecoveryReplay(); detachInput?.(); detachInput = undefined; dispose(); };
    signal.addEventListener('abort', abortHandler, { once: true });
    let adapter: GPUAdapter | null;
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch (error) {
      return disposed || signal.aborted ? { status: 'cancelled' } : failMount(options, error);
    }
    if (disposed || signal.aborted) return { status: 'cancelled' };
    if (!adapter || adapter.limits.maxTextureDimension2D < 2048) {
      return failMount(options, new Error('WebGPU adapter 或必要纹理限制不满足要求。'));
    }
    const inputEvents = ['pointerdown', 'touchstart', 'wheel', 'dblclick'] as const;
    // Capture at the actual input boundary, before the native orbit/picking
    // handlers update world state. These paths never call backend setters.
    for (const event of inputEvents) canvas.addEventListener(event, markUserInteraction, { capture: true, passive: true });
    detachInput = () => {
      for (const event of inputEvents) canvas.removeEventListener(event, markUserInteraction, true);
    };
    let mountedWorld: LiteWorld | undefined;
    let restarting = false;
    // A loss during the replacement-scene build cannot start a second rebuild inline; queue it so
    // the replacement is never left on the in-place native recovery path this strategy avoids.
    let restartPending = false;
    let pendingPose: CameraPose | null = null;
    let pendingSelection: number | null = null;
    let failureReported = false;

    const emitFailure = (error: unknown) => {
      if (failureReported) return;
      failureReported = true;
      emit(options, { type: 'failed', message: errorMessage(error), error });
    };

    const statusHandler = (instance: LiteRuntime, status: string, error?: unknown) => {
      if (!active(options) || instance !== runtime) return;
      lifecycle.statuses.push(status);
      if (status === 'initializing') emit(options, { type: 'initializing', message: '正在初始化 WebGPU…' });
      else if (status === 'lost') {
        lifecycle.losses += 1;
        emit(options, { type: 'recovering', message: 'GPU 设备已丢失，正在重新构建设备和静态场景。若失败，请重新加载视图。', cause: 'device-lost' });
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
        emit(options, { type: 'ready', message: 'WebGPU · 程序化 FAB · 121 台设备' });
        installPerf();
        if (pendingPose) {
          const pose = pendingPose, selection = pendingSelection;
          pendingPose = null; pendingSelection = null;
          // The lifecycle ready observer runs before the page's preset effect; re-apply once more
          // after it has settled so the preserved pose cannot lose the ordering race with the
          // preset. Both timers are cancelled when the user interacts, a newer recovery starts or
          // the backend is disposed, and the callback re-validates the captured identity.
          cancelRecoveryReplay();
          const scheduledWorld = world;
          const scheduledGeneration = recoveryGeneration;
          const scheduledVersion = interactionVersion;
          const applyRestoredState = () => {
            if (!active(options) || !world || world !== scheduledWorld
              || recoveryGeneration !== scheduledGeneration || interactionVersion !== scheduledVersion) return;
            world.setCameraPose(pose.position, pose.target, 0);
            if (selection !== null) world.selectTool(selection, false);
          };
          scheduleRecoveryReplay(applyRestoredState, 0);
          scheduleRecoveryReplay(applyRestoredState, 300);
        }
      } else if (status === 'failed') {
        console.error('[lite] runtime failed', error, (error as { cause?: { stack?: string } } | undefined)?.cause?.stack ?? '');
        emitFailure(error);
      }
    };

    const createInstance = (): LiteRuntime => {
      // The disposer must own this mount's world even after `world` is cleared for a restart.
      let ownedWorld: LiteWorld | undefined;
      let instance: LiteRuntime = undefined as unknown as LiteRuntime;
      instance = createLiteRuntime(canvas, {
        signal,
        async compose(scene, engine) {
          emit(options, { type: 'initializing', message: '正在加载原版设备模型…' });
          ownedWorld = await createLiteWorld(scene, engine, canvas, {
            // Readonly callbacks outlive React renders; they are gated by the mount lifetime so a
            // stale world that settles after cancellation/disposal cannot reach the page.
            onToolPick: tool => { if (active(options)) callbacks.onToolPick(tool); },
            onToolHover: hover => { if (active(options)) callbacks.onToolHover(hover); },
            onAmhsStats: stats => { if (active(options)) callbacks.onAmhsStats(stats); },
            getToolStates: () => callbacks.getToolStates(),
          });
          // A compose that settles after abort/dispose must not retain the late GPU world.
          if (!active(options)) { ownedWorld.dispose(); ownedWorld = undefined; return () => {}; }
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
      if (!active(options)) { restarting = false; return; }
      try {
        await createInstance().ready;
      } catch (restartError) {
        if (active(options)) emitFailure(restartError);
      } finally {
        restarting = false;
      }
      if (restartPending) {
        restartPending = false;
        const current = runtime;
        if (current && active(options)) void restart(current);
      }
    };

    const first = createInstance();
    try {
      await first.ready;
    } catch (error) {
      if (disposed || signal.aborted) return { status: 'cancelled' };
      emitFailure(error);
      dispose();
      return { status: 'failed', error };
    }
    if (disposed || signal.aborted) return { status: 'cancelled' };
    return { status: 'ready' };
  }

  const mount = (options: SceneMountOptions): Promise<SceneMountOutcome> => {
    if (mountPromise) {
      // Stable identity: one port instance owns exactly one viewer's GPU lifetime.
      if (mountOptions?.viewerId !== options.viewerId) {
        throw new Error('此 ScenePort 实例已绑定 viewer "' + (mountOptions?.viewerId ?? '') + '"，不能复用于 "' + options.viewerId + '"；每个 viewer 必须创建独立端口实例。');
      }
      return mountPromise;
    }
    mountOptions = options;
    mountPromise = mountScene(options);
    return mountPromise;
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (mountOptions && abortHandler) mountOptions.signal.removeEventListener('abort', abortHandler);
    abortHandler = undefined;
    detachInput?.(); detachInput = undefined;
    cancelRecoveryReplay();
    perf?.dispose(); perf = undefined;
    runtime?.dispose(); runtime = undefined;
    world = undefined;
  }

  return {
    acceptance: {
      forceDeviceLoss() { if (!disposed) world?.forceDeviceLoss(); },
    },
    mount,
    dispose,
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
    setLanguage(language: SceneLanguage): void { if (!disposed) world?.setLanguage(language); },
  };
}
