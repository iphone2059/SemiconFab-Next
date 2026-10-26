import {
  createEngine, createSceneContext, enableDeviceLostSceneRecovery,
  registerScene, startEngine, waitForGpuIdle, stopEngine, disposeScene, disposeEngine,
  type DeviceLostRecoveryHandle, type EngineContext, type SceneContext,
} from '@babylonjs/lite';

export type LiteRuntimeStatus = 'initializing' | 'ready' | 'lost' | 'failed' | 'disposed';
export interface LiteRuntimeOptions {
  readonly signal?: AbortSignal;
  /** Synchronous scene composition. Return the disposer for controls and other DOM resources. */
  readonly compose: (scene: SceneContext, engine: EngineContext) => void | (() => void);
  readonly onStatus?: (status: LiteRuntimeStatus, error?: unknown) => void;
}
export interface LiteRuntime {
  readonly ready: Promise<{ engine: EngineContext; scene: SceneContext }>;
  readonly status: LiteRuntimeStatus;
  dispose(): void;
}

/** Owns a single Lite scene, including cancellation during deferred GPU setup. */
export function createLiteRuntime(canvas: HTMLCanvasElement, options: LiteRuntimeOptions): LiteRuntime {
  let status: LiteRuntimeStatus = 'initializing';
  let engine: EngineContext | undefined;
  let scene: SceneContext | undefined;
  let recovery: DeviceLostRecoveryHandle | undefined;
  let detach: (() => void) | undefined;
  let initializing = true;
  let firstFrameReady = false;
  let renderingRequested = false;
  let recovering = false;
  let lossGeneration = 0;
  let recoverySettled: Promise<void> = Promise.resolve();
  let finishRecovery: (() => void) | undefined;
  let resumedFirstFrame: (() => void) | undefined;
  let disposed = false;
  let released = false;
  const cancellation = new AbortController();

  function report(next: LiteRuntimeStatus, error?: unknown) {
    if (disposed || released) return;
    status = next;
    options.onStatus?.(next, error);
  }
  function release() {
    if (released) return;
    released = true;
    options.signal?.removeEventListener('abort', dispose);
    try {
      if (engine) stopEngine(engine);
    } finally {
      try {
        recovery?.disable();
      } finally {
        try { detach?.(); }
        finally {
          try { if (scene) disposeScene(scene); }
          finally { if (engine) disposeEngine(engine); }
        }
      }
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    status = 'disposed';
    cancellation.abort();
    // Lite disable() does not cancel a captured recovery. It may still replace the device.
    // Keep ownership until both initialization and native recovery have settled.
    if (!initializing && !recovering) release();
  }
  async function firstFrameBoundary(operation: Promise<void>) {
    const signal = cancellation.signal;
    signal.throwIfAborted();
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    try { await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  function settleRecovery() {
    recovering = false;
    finishRecovery?.();
    resumedFirstFrame?.();
    if (!initializing && (disposed || status === 'failed')) release();
    else if (firstFrameReady) report('ready');
  }
  function failRecovery(error: unknown) {
    recovering = false;
    finishRecovery?.();
    if (released) return;
    if (initializing) cancellation.abort(error);
    else { try { report('failed', error); } finally { release(); } }
  }

  options.signal?.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) dispose();
  const ready = (async () => {
    try {
      cancellation.signal.throwIfAborted();
      report('initializing');
      cancellation.signal.throwIfAborted();
      engine = await createEngine(canvas);
      cancellation.signal.throwIfAborted();
      // Enable capture before creating any geometry or textures.
      recovery = enableDeviceLostSceneRecovery(engine, {
        onLost: () => {
          if (released) return;
          // Initialization may already await this barrier. Consecutive losses
          // belong to the same recovery until the newest GPU frame completes.
          if (!recovering) recoverySettled = new Promise(resolve => { finishRecovery = resolve; });
          recovering = true;
          lossGeneration++;
          // Native recovery is loaded asynchronously. Stop now, before owners reset
          // device-bound data, so an old-device RAF cannot repopulate those caches.
          stopEngine(engine!);
          report('lost');
        },
        // We paused before native recovery, so Lite rebuilds without restarting.
        // The owner resumes only after rebuilding, and confirms the replacement GPU frame.
        onRecovered: () => {
          if (released) return;
          if (disposed || status === 'failed' || !renderingRequested) { settleRecovery(); return; }
          const generation = lossGeneration;
          void (async () => {
            try {
              await firstFrameBoundary(startEngine(engine!));
              if (generation !== lossGeneration) return;
              await firstFrameBoundary(waitForGpuIdle(engine!));
              if (generation === lossGeneration) settleRecovery();
            } catch (error) {
              if (generation !== lossGeneration) return;
              if (disposed) settleRecovery();
              else failRecovery(error);
            }
          })();
        },
        onRecoveryFailed: failRecovery,
      });
      scene = createSceneContext(engine);
      detach = options.compose(scene, engine) || undefined;
      cancellation.signal.throwIfAborted();
      await registerScene(scene);
      cancellation.signal.throwIfAborted();
      while (recovering) await firstFrameBoundary(recoverySettled);
      cancellation.signal.throwIfAborted();
      // stopEngine cancels RAF without resolving startEngine; cancellation must race this wait.
      // A loss before that RAF also cancels it; native recovery supplies a different first frame.
      const recoveredFrame = new Promise<void>(resolve => { resumedFirstFrame = resolve; });
      renderingRequested = true;
      await firstFrameBoundary(Promise.race([startEngine(engine), recoveredFrame]));
      resumedFirstFrame = undefined;
      for (;;) {
        if (recovering) await firstFrameBoundary(recoverySettled);
        const submittedGeneration = lossGeneration;
        try { await firstFrameBoundary(waitForGpuIdle(engine)); }
        catch (error) {
          if (cancellation.signal.aborted || submittedGeneration === lossGeneration) throw error;
          continue;
        }
        if (!recovering && submittedGeneration === lossGeneration) break;
      }
      cancellation.signal.throwIfAborted();
      firstFrameReady = true;
      report('ready');
      cancellation.signal.throwIfAborted();
      return { engine, scene };
    } catch (error) {
      try { report('failed', error); } finally { if (!recovering) release(); }
      throw error;
    } finally {
      initializing = false;
      resumedFirstFrame = undefined;
      if (disposed && !recovering) release();
    }
  })();
  return { ready, get status() { return status; }, dispose };
}
