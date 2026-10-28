import type {
  CameraPose, SceneLifecycleEvent, SceneMountOptions, SceneMountOutcome, ScenePort, SceneViewPreset,
} from '../../src/application/ports/scene';

/**
 * Typed test double for the rendering backend returned by `createLiteBackend()`.
 *
 * Vitest mock factories for `rendering/lite-backend` import this module, so page/component tests
 * keep the real feature code, stores and React effects while the GPU boundary is replaced by a
 * genuine `ScenePort` implementation (all required capabilities present, no optional methods).
 * A test can configure the next mount (`ready` / `failed` / `reject` / `manual`) and inspect
 * the recorded mount options, command calls and dispose count.
 */
export type ScenePortMountMode = 'ready' | 'failed' | 'reject' | 'manual';

interface ScenePortStubControl {
  mode: ScenePortMountMode;
  readyMessage: string;
  failure: unknown;
  onMount?: (options: SceneMountOptions) => void;
}

const control: ScenePortStubControl = { mode: 'ready', readyMessage: 'WebGPU · ready', failure: undefined };
let pendingMount: ((outcome: SceneMountOutcome) => void) | undefined;

export function configureScenePortStub(patch: Partial<ScenePortStubControl>): void {
  Object.assign(control, patch);
}

export function resetScenePortStub(): void {
  control.mode = 'ready';
  control.readyMessage = 'WebGPU · ready';
  control.failure = undefined;
  control.onMount = undefined;
  pendingMount = undefined;
}

/** Settle a mount created with mode 'manual' (late-promise lifecycle tests). */
export function resolveScenePortMount(outcome: SceneMountOutcome): void {
  const resolve = pendingMount;
  pendingMount = undefined;
  resolve?.(outcome);
}

export interface ScenePortStub extends ScenePort {
  readonly mounts: readonly SceneMountOptions[];
  readonly calls: readonly string[];
  /** setView presets in call order (fabId suffix when provided). */
  readonly views: readonly string[];
  readonly disposeCount: number;
  /** Emit a lifecycle event through the most recent mount's readonly callback. */
  emit(event: SceneLifecycleEvent): void;
}

export function createScenePortStub(): ScenePortStub {
  const mounts: SceneMountOptions[] = [];
  const calls: string[] = [];
  const views: string[] = [];
  let disposeCount = 0;
  const record = (name: string) => { calls.push(name); };
  const commands = {
    setCameraPose: (..._args: unknown[]) => { record('setCameraPose'); },
    getCameraPose: (): CameraPose | null => { record('getCameraPose'); return null; },
    zoom: (..._args: unknown[]) => { record('zoom'); },
    resize: () => { record('resize'); },
    clearSelection: () => { record('clearSelection'); },
    selectTool: (..._args: unknown[]) => { record('selectTool'); },
    setLayer: (..._args: unknown[]) => { record('setLayer'); },
    setToolState: (..._args: unknown[]) => { record('setToolState'); },
    setTour: (..._args: unknown[]) => { record('setTour'); },
    setExplodeFactor: (..._args: unknown[]) => { record('setExplodeFactor'); },
    setBasement: (..._args: unknown[]) => { record('setBasement'); },
    setDual: (..._args: unknown[]) => { record('setDual'); },
    setCutPlane: (..._args: unknown[]) => { record('setCutPlane'); },
    setXRayFilter: (..._args: unknown[]) => { record('setXRayFilter'); },
    setWaferPoint: (..._args: unknown[]) => { record('setWaferPoint'); },
    setWaferTrail: (..._args: unknown[]) => { record('setWaferTrail'); },
    focusPatrol: () => { record('focusPatrol'); },
    setLanguage: (..._args: unknown[]) => { record('setLanguage'); },
    setView: (preset: SceneViewPreset, fabId?: string) => {
      record('setView');
      views.push(fabId ? preset + ':' + fabId : preset);
    },
  };
  const stub: ScenePortStub = {
    ...commands,
    acceptance: { forceDeviceLoss: () => { record('forceDeviceLoss'); } },
    get mounts() { return mounts; },
    get calls() { return calls; },
    get views() { return views; },
    get disposeCount() { return disposeCount; },
    emit(event) { mounts.at(-1)?.callbacks.onLifecycle(event); },
    mount(options) {
      mounts.push(options);
      control.onMount?.(options);
      if (control.mode === 'manual') {
        return new Promise<SceneMountOutcome>(resolve => { pendingMount = resolve; });
      }
      if (control.mode === 'failed') {
        const error = control.failure ?? new Error('WebGPU 初始化失败');
        stub.emit({ type: 'failed', message: error instanceof Error ? error.message : 'WebGPU 初始化失败', error });
        return Promise.resolve({ status: 'failed', error });
      }
      if (control.mode === 'reject') {
        return Promise.reject(control.failure ?? new Error('WebGPU 初始化失败'));
      }
      stub.emit({ type: 'ready', message: control.readyMessage });
      return Promise.resolve({ status: 'ready' });
    },
    dispose() { disposeCount += 1; },
  };
  return stub;
}
