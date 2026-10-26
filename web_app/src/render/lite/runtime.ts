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
    // createEngine/registerScene may still be writing resources. Release after they settle.
    if (!initializing) release();
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

  options.signal?.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) dispose();
  const ready = (async () => {
    try {
      cancellation.signal.throwIfAborted();
      report('initializing');
      engine = await createEngine(canvas);
      cancellation.signal.throwIfAborted();
      // Enable capture before creating any geometry or textures.
      recovery = enableDeviceLostSceneRecovery(engine, {
        onLost: () => report('lost'),
        // Lite invokes this only after the rebuilt scene's first resumed frame.
        onRecovered: () => { if (firstFrameReady) report('ready'); },
        onRecoveryFailed: error => {
          if (disposed || released) return;
          if (initializing) cancellation.abort(error);
          else { try { report('failed', error); } finally { release(); } }
        },
      });
      scene = createSceneContext(engine);
      detach = options.compose(scene, engine) || undefined;
      cancellation.signal.throwIfAborted();
      await registerScene(scene);
      cancellation.signal.throwIfAborted();
      // stopEngine cancels RAF without resolving startEngine; cancellation must race this wait.
      await firstFrameBoundary(startEngine(engine));
      await firstFrameBoundary(waitForGpuIdle(engine));
      cancellation.signal.throwIfAborted();
      firstFrameReady = true;
      report('ready');
      return { engine, scene };
    } catch (error) {
      try { report('failed', error); } finally { release(); }
      throw error;
    } finally {
      initializing = false;
      if (disposed) release();
    }
  })();
  return { ready, get status() { return status; }, dispose };
}
