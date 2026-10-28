import { beforeEach, expect, it, vi } from 'vitest';
import type { PickedTool, SceneLifecycleEvent, SceneMountOptions, ScenePort } from '../../src/application/ports/scene';

/**
 * Product ScenePort lifecycle tests (R-04).
 *
 * The native Lite runtime and product world are doubled at their module boundary; mount
 * idempotency, cancellation, terminal failure, late-promise suppression and device-loss
 * recovery are the real backend logic. Every required capability is also asserted at runtime
 * against a typed `ScenePort` so a silently-missing optional method cannot pass.
 */
type Point = readonly [number, number, number];
interface FakeWorld {
  [name: string]: unknown;
}

const mocks = vi.hoisted(() => {
  return {
    timers: [] as { id: number; delay: number; run: () => void; cleared: boolean }[],
    nextTimer: 1,
    runtimes: [] as any[],
    worlds: [] as any[],
    worldCallbacks: [] as any[],
    worldFactory: null as null | (() => Promise<any>),
  };
});

vi.mock('../../src/rendering/lite/runtime', () => ({
  createLiteRuntime: vi.fn((_canvas: unknown, options: any) => {
    const scene = { shadowGenerators: [], lights: [] };
    let resolveReady!: (value: unknown) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveReleased!: () => void;
    const whenReleased = new Promise<void>(resolve => { resolveReleased = resolve; });
    let composeDisposer: (() => void) | undefined;
    const instance: any = { status: 'initializing', options, ready, whenReleased };
    instance.dispose = () => {
      if (instance.status === 'disposed') return;
      instance.status = 'disposed';
      try { composeDisposer?.(); } finally { resolveReleased(); }
    };
    mocks.runtimes.push(instance);
    options.onStatus?.('initializing');
    void (async () => {
      try {
        const disposer = await options.compose(scene, {});
        composeDisposer = typeof disposer === 'function' ? disposer : undefined;
        // A dispose() during composition defers the owned-world release until the late
        // composition settles, exactly like the native runtime's deferred release.
        if (instance.status === 'disposed') { composeDisposer?.(); composeDisposer = undefined; }
        options.onStatus?.('ready');
        resolveReady({ scene, engine: {} });
      } catch (error) {
        options.onStatus?.('failed', error);
        rejectReady(error);
      }
    })();
    return instance;
  }),
}));

vi.mock('../../src/rendering/lite/world', () => ({
  createLiteWorld: vi.fn(async (_scene: unknown, _engine: unknown, _canvas: unknown, callbacks: any) => {
    mocks.worldCallbacks.push(callbacks);
    const world = await mocks.worldFactory!();
    mocks.worlds.push(world);
    return world;
  }),
}));

import { createLiteBackend } from '../../src/rendering/lite-backend';

let canvas: HTMLCanvasElement;
const flush = async (steps = 80) => { for (let index = 0; index < steps; index++) await Promise.resolve(); };
const activeTimers = () => mocks.timers.filter(timer => !timer.cleared);

function fakeWorld(pose: { position: Point; target: Point } | null = null, selection: number | null = null): FakeWorld {
  const world: any = { pose, selected: selection, disposed: 0 };
  world.setCameraPose = vi.fn((position: Point, target: Point) => { world.pose = { position: [...position], target: [...target] }; });
  world.selectTool = vi.fn((index: number) => { world.selected = index; });
  world.clearSelection = vi.fn(() => { world.selected = null; });
  world.getCameraPose = vi.fn(() => world.pose);
  world.readDiagnostics = vi.fn(() => ({ gpuErrors: [], selection: { index: world.selected } }));
  world.readPerf = vi.fn(() => ({ cameraPose: world.pose }));
  for (const name of ['registerLabels', 'setView', 'zoom', 'resize', 'setLayer', 'setToolState', 'setTour',
    'setExplodeFactor', 'setBasement', 'setDual', 'setCutPlane', 'setXRayFilter', 'setWaferPoint',
    'setWaferTrail', 'focusPatrol', 'setLanguage']) world[name] = vi.fn(async () => undefined);
  world.forceDeviceLoss = vi.fn();
  world.dispose = vi.fn(() => { world.disposed += 1; });
  return world;
}

interface Harness {
  readonly backend: ReturnType<typeof createLiteBackend>;
  readonly options: SceneMountOptions;
  readonly events: SceneLifecycleEvent[];
  readonly picks: (PickedTool | null)[];
  readonly hovers: unknown[];
  readonly stats: unknown[];
  readonly controller: AbortController;
}

function createHarness(viewerId = 'viewer-1'): Harness {
  const controller = new AbortController();
  const events: SceneLifecycleEvent[] = [];
  const picks: (PickedTool | null)[] = [];
  const hovers: unknown[] = [];
  const stats: unknown[] = [];
  const backend = createLiteBackend();
  const options: SceneMountOptions = {
    viewerId,
    canvas,
    fabs: [],
    signal: controller.signal,
    callbacks: {
      onLifecycle: event => events.push(event),
      onToolPick: tool => picks.push(tool),
      onToolHover: hover => hovers.push(hover),
      onAmhsStats: value => stats.push(value),
      getToolStates: () => ['running', 'down', 'idle', 'maint'],
    },
  };
  return { backend, options, events, picks, hovers, stats, controller };
}

beforeEach(() => {
  canvas = new EventTarget() as HTMLCanvasElement;
  mocks.runtimes.length = 0;
  mocks.worlds.length = 0;
  mocks.worldCallbacks.length = 0;
  mocks.timers.length = 0;
  mocks.nextTimer = 1;
  mocks.worldFactory = async () => fakeWorld();
  vi.stubGlobal('window', {
    isSecureContext: true,
    setTimeout: (callback: () => void, delay: number) => {
      const id = mocks.nextTimer++;
      mocks.timers.push({ id, delay, run: callback, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const timer = mocks.timers.find(candidate => candidate.id === id);
      if (timer) timer.cleared = true;
    },
  });
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ limits: { maxTextureDimension2D: 4096 } }) } });
});

it('exposes every required product capability and no optional command surface', () => {
  const backend: ScenePort = createLiteBackend();
  const commands = ['setView', 'setCameraPose', 'getCameraPose', 'zoom', 'resize', 'clearSelection', 'selectTool',
    'setLayer', 'setToolState', 'setTour', 'setExplodeFactor', 'setBasement', 'setDual', 'setCutPlane',
    'setXRayFilter', 'setWaferPoint', 'setWaferTrail', 'focusPatrol', 'setLanguage'] as const;
  for (const command of commands) expect(typeof backend[command], command).toBe('function');
  expect(typeof backend.mount).toBe('function');
  expect(typeof backend.dispose).toBe('function');
});

it('mounts once with a stable identity and dispose releases the GPU lifetime exactly once', async () => {
  const harness = createHarness();
  const first = harness.backend.mount(harness.options);
  const repeated = harness.backend.mount(harness.options);
  expect(repeated).toBe(first);
  await expect(first).resolves.toEqual({ status: 'ready' });
  expect(mocks.runtimes).toHaveLength(1);
  expect(harness.events.map(event => event.type)).toEqual(['initializing', 'initializing', 'ready']);
  expect(harness.events.at(-1)?.message).toBe('WebGPU · 程序化 FAB · 121 台设备');

  const world = mocks.worlds[0];
  harness.backend.setView('top');
  harness.backend.zoom(40);
  harness.backend.selectTool(3, true);
  harness.backend.setXRayFilter('gas');
  harness.backend.setLanguage('en');
  expect(world.setView).toHaveBeenCalledWith('top', undefined);
  expect(world.zoom).toHaveBeenCalledWith(40);
  expect(world.selectTool).toHaveBeenCalledWith(3, true);
  expect(world.setXRayFilter).toHaveBeenCalledWith('gas');
  expect(world.setLanguage).toHaveBeenCalledWith('en');
  expect(harness.backend.getCameraPose()).toBeNull();

  // The acceptance capability group is explicit and forwards to the owning world.
  harness.backend.acceptance.forceDeviceLoss();
  expect(world.forceDeviceLoss).toHaveBeenCalledOnce();

  harness.backend.dispose();
  harness.backend.dispose();
  expect(world.disposed).toBe(1);
  expect(mocks.runtimes[0].status).toBe('disposed');
  // Commands after dispose are gated by the dead lifetime, not silently forwarded.
  harness.backend.setView('iso');
  expect(world.setView).toHaveBeenCalledTimes(1);

  // One port instance keeps one identity: a different viewer id is rejected explicitly.
  expect(() => harness.backend.mount({ ...harness.options, viewerId: 'viewer-2' })).toThrow(/viewer/);
  await expect(harness.backend.mount(harness.options)).resolves.toEqual({ status: 'ready' });
});

it('reports a failed mount once, releases resources and suppresses every late callback', async () => {
  const failure = new Error('模型资产加载失败');
  mocks.worldFactory = async () => { throw failure; };
  const harness = createHarness();
  const outcome = await harness.backend.mount(harness.options);
  expect(outcome).toEqual({ status: 'failed', error: failure });
  expect(harness.events.filter(event => event.type === 'failed')).toHaveLength(1);
  expect(harness.events.at(-1)).toMatchObject({ type: 'failed', message: '模型资产加载失败' });
  expect(harness.events.some(event => event.type === 'ready')).toBe(false);
  expect(mocks.runtimes[0].status).toBe('disposed');
  harness.backend.dispose();

  // A status callback that settles after the failed mount cannot resurrect the lifecycle.
  mocks.runtimes[0].options.onStatus?.('lost');
  mocks.runtimes[0].options.onStatus?.('ready');
  expect(harness.events.filter(event => event.type === 'recovering')).toHaveLength(0);
  expect(harness.events.filter(event => event.type === 'ready')).toHaveLength(0);
});

it('fails explicitly when the browser has no WebGPU device instead of hanging in initialization', async () => {
  vi.stubGlobal('navigator', {});
  const harness = createHarness();
  const outcome = await harness.backend.mount(harness.options);
  expect(outcome.status).toBe('failed');
  expect(harness.events).toHaveLength(1);
  expect(harness.events[0]).toMatchObject({ type: 'failed' });
  expect(harness.events[0].message).toContain('WebGPU');
  expect(mocks.runtimes).toHaveLength(0);
});

it('a cancelled mount disposes the late GPU world and never forwards stale callbacks', async () => {
  const lateWorld = fakeWorld();
  let releaseWorld!: (world: FakeWorld) => void;
  mocks.worldFactory = () => new Promise(resolve => { releaseWorld = resolve; });
  const harness = createHarness();
  const pending = harness.backend.mount(harness.options);
  await vi.waitFor(() => expect(mocks.worldCallbacks).toHaveLength(1));

  harness.controller.abort();
  releaseWorld(lateWorld);
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  await flush();
  expect(lateWorld.disposed).toBe(1);
  expect(harness.events.some(event => event.type === 'ready')).toBe(false);

  // The callbacks captured by the late world were created before cancellation; they must be
  // inert so a stale picking/frame loop can never reach the page after the viewer replaced it.
  const callbacks = mocks.worldCallbacks[0];
  callbacks.onToolPick({ index: 1 });
  callbacks.onToolHover(null);
  callbacks.onAmhsStats({ active: 0, total: 0, queued: 0, completed: 0, avgDelivery: null });
  expect(harness.picks).toEqual([]);
  expect(harness.hovers).toEqual([]);
  expect(harness.stats).toEqual([]);
  harness.backend.dispose();
});

it('a mount whose signal was already aborted is cancelled without acquiring a device', async () => {
  const harness = createHarness();
  harness.controller.abort();
  await expect(harness.backend.mount(harness.options)).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.runtimes).toHaveLength(0);
  expect(mocks.worldCallbacks).toHaveLength(0);
  expect(harness.events).toEqual([]);
  harness.backend.dispose();
});

it('a recoverable device loss reports recovering then ready and restores pose/selection', async () => {
  const firstWorld = fakeWorld({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  const replacement = fakeWorld();
  const queue = [firstWorld, replacement];
  mocks.worldFactory = async () => queue.shift()!;
  const harness = createHarness();
  await harness.backend.mount(harness.options);
  expect(harness.events.at(-1)?.type).toBe('ready');

  mocks.runtimes[0].options.onStatus?.('lost');
  await vi.waitFor(() => expect(harness.events.filter(event => event.type === 'recovering')).toHaveLength(1));
  await vi.waitFor(() => expect(activeTimers()).toHaveLength(2));
  for (const timer of [...mocks.timers]) timer.run();

  // The first mount reports the runtime initialization + the native model load; the
  // replacement scene reports its own load phase between 'recovering' and the new 'ready'.
  expect(harness.events.map(event => event.type)).toEqual([
    'initializing', 'initializing', 'ready', 'recovering', 'initializing', 'ready',
  ]);
  expect(harness.events.find(event => event.type === 'recovering')).toMatchObject({ cause: 'device-lost' });
  expect(firstWorld.disposed).toBe(1);
  expect(replacement.pose).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
  expect(replacement.selected).toBe(42);
  // The rebuilt scene is the command target for the same viewer identity.
  harness.backend.setView('top');
  expect(replacement.setView).toHaveBeenCalledWith('top', undefined);
  harness.backend.dispose();
  expect(replacement.disposed).toBe(1);
});

it('dispose during recovery replay cancels the pending restore and suppresses stale callbacks', async () => {
  const firstWorld = fakeWorld({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  const replacement = fakeWorld();
  const queue = [firstWorld, replacement];
  mocks.worldFactory = async () => queue.shift()!;
  const harness = createHarness();
  await harness.backend.mount(harness.options);
  mocks.runtimes[0].options.onStatus?.('lost');
  await vi.waitFor(() => expect(activeTimers()).toHaveLength(2));
  const pendingReplays = [...mocks.timers];

  harness.backend.dispose();
  expect(pendingReplays.every(timer => timer.cleared)).toBe(true);
  for (const timer of pendingReplays) timer.run();
  expect(replacement.pose).toBeNull();
  expect(replacement.selected).toBeNull();
  expect(replacement.setCameraPose).not.toHaveBeenCalled();
  // A late recovery failure from the replaced runtime cannot emit after disposal.
  mocks.runtimes.at(-1).options.onStatus?.('failed', new Error('late failure'));
  expect(harness.events.filter(event => event.type === 'failed')).toHaveLength(0);
});

it('a failed recoverable rebuild reports a terminal failure after the recovering event', async () => {
  let compositions = 0;
  mocks.worldFactory = async () => {
    compositions += 1;
    if (compositions === 1) return fakeWorld();
    throw new Error('重建静态场景失败');
  };
  const harness = createHarness();
  await harness.backend.mount(harness.options);
  mocks.runtimes[0].options.onStatus?.('lost');
  await vi.waitFor(() => expect(harness.events.filter(event => event.type === 'failed')).toHaveLength(1));
  expect(harness.events.map(event => event.type)).toEqual([
    'initializing', 'initializing', 'ready', 'recovering', 'initializing', 'failed',
  ]);
  expect(harness.events.at(-1)?.message).toBe('重建静态场景失败');
  harness.backend.dispose();
});
