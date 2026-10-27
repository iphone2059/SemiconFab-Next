import { beforeEach, expect, it, vi } from 'vitest';

// A08: the product recovery scheduler is isolated from the GPU. The native runtime and world
// are doubled at their module boundary; the backend's own timer/generation/version logic is real.
const mocks = vi.hoisted(() => ({
  runtimes: [] as any[],
  worlds: [] as any[],
  created: [] as any[],
  timers: [] as { id: number; delay: number; run: () => void; cleared: boolean }[],
  nextTimer: 1,
}));
vi.mock('../src/rendering/lite/runtime', () => ({
  createLiteRuntime: vi.fn((_canvas: unknown, options: any) => {
    const scene = { shadowGenerators: [], lights: [] };
    let resolveReady!: (value: unknown) => void;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    let resolveReleased!: () => void;
    const whenReleased = new Promise<void>(resolve => { resolveReleased = resolve; });
    const instance: any = { status: 'initializing', options, ready, whenReleased };
    instance.dispose = () => {
      instance.status = 'disposed';
      resolveReleased();
    };
    mocks.runtimes.push(instance);
    void (async () => {
      await options.compose(scene, {});
      options.onStatus?.('ready');
      resolveReady({ scene, engine: {} });
    })();
    return instance;
  }),
}));
vi.mock('../src/rendering/lite/world', () => ({
  createLiteWorld: vi.fn(async () => {
    const world = mocks.worlds.shift();
    mocks.created.push(world);
    return world;
  }),
}));

import { createLiteBackend } from '../src/lite-backend';

type Point = readonly [number, number, number];
function fakeWorld(pose: { position: Point; target: Point } | null, selection: number | null) {
  const world: any = {
    pose,
    selected: selection,
    setCameraPose: vi.fn((position: Point, target: Point) => { world.pose = { position: [...position], target: [...target] }; }),
    selectTool: vi.fn((index: number) => { world.selected = index; }),
    clearSelection: vi.fn(() => { world.selected = null; }),
    getCameraPose: vi.fn(() => world.pose),
    readDiagnostics: vi.fn(() => ({ gpuErrors: [], selection: { index: world.selected } })),
  };
  for (const name of ['registerLabels', 'setView', 'zoom', 'resize', 'setLayer', 'setToolState', 'setTour',
    'setExplodeFactor', 'setBasement', 'setDual', 'setCutPlane', 'setXRayFilter', 'setWaferPoint',
    'setWaferTrail', 'focusPatrol', 'setLanguage']) world[name] = vi.fn(async () => undefined);
  world.readPerf = vi.fn(() => ({ cameraPose: world.pose }));
  return world;
}
function queueWorld(pose: { position: Point; target: Point } | null, selection: number | null) {
  const world = fakeWorld(pose, selection);
  mocks.worlds.push(world);
  return world;
}
let canvas: HTMLCanvasElement;
const flush = async (steps = 80) => { for (let index = 0; index < steps; index++) await Promise.resolve(); };
async function mountBackend(pose: { position: Point; target: Point } | null, selection: number | null) {
  const firstWorld = queueWorld(pose, selection);
  const controller = new AbortController();
  const backend = createLiteBackend();
  await backend.mount(canvas, [], controller.signal, () => {});
  return { backend, controller, firstWorld };
}
const activeTimers = () => mocks.timers.filter(timer => !timer.cleared);
/** Simulate a device loss on the current runtime and wait for the replacement world + replay. */
async function loseDevice() {
  mocks.runtimes[mocks.runtimes.length - 1].options.onStatus?.('lost');
  await vi.waitFor(() => expect(activeTimers()).toHaveLength(2));
  await flush();
}
function runReplays(): void {
  // Fire every scheduled callback, including ones a cleared timer should have removed, so the
  // generation/interaction-version guards inside the callback are exercised too.
  for (const timer of [...mocks.timers]) timer.run();
}

beforeEach(() => {
  canvas = new EventTarget() as HTMLCanvasElement;
  mocks.runtimes.length = 0;
  mocks.worlds.length = 0;
  mocks.created.length = 0;
  mocks.timers.length = 0;
  mocks.nextTimer = 1;
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

it.each(['pointerdown', 'wheel', 'touchstart', 'dblclick'])('keeps canvas %s input newer than the recovery replay', async (eventType) => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    mocks.timers[0].run();
    canvas.dispatchEvent(new Event(eventType));
    // The real camera/selection input handlers change world state without
    // invoking backend setters. Keep that boundary independent of the GPU.
    replacement.setCameraPose([9, 9, 9], [0, 0, 0]);
    replacement.selectTool(7);
    mocks.timers[1].run();
    expect(replacement.pose.position).toEqual([9, 9, 9]);
    expect(replacement.selected).toBe(7);
  } finally { backend.dispose(); }
});

it('a user preset cancels recovery replay', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    backend.setView!('top');
    runReplays();
    expect(mocks.created[1].setCameraPose).not.toHaveBeenCalled();
    expect(activeTimers()).toHaveLength(0);
  } finally { backend.dispose(); }
});

it('restores the preserved camera pose and selection after a normal GPU recovery', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    expect(mocks.created).toHaveLength(2);
    expect(mocks.timers.map(timer => timer.delay)).toEqual([0, 300]);
    const replacement = mocks.created[1];
    runReplays();
    expect(replacement.pose).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
    expect(replacement.selected).toBe(42);
    expect(backend.getCameraPose!()).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
  } finally { backend.dispose(); }
});

it('does not replay the recovered pose over a newer user camera move', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    const [initialReplay, delayedReplay] = mocks.timers;
    // Audited sequence: the 0 ms replay restores [1,2,3]; the user then moves to [9,9,9]; the
    // pending 300 ms replay must not put the recovered pose back.
    initialReplay.run();
    expect(replacement.pose).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
    backend.setCameraPose!([9, 9, 9], [0, 0, 0], 0);
    expect(replacement.pose).toEqual({ position: [9, 9, 9], target: [0, 0, 0] });
    expect(delayedReplay.cleared).toBe(true);
    delayedReplay.run();
    expect(replacement.pose).toEqual({ position: [9, 9, 9], target: [0, 0, 0] });
    // The preserved pose was applied once by the first replay, then the newer user pose won.
    expect(replacement.setCameraPose.mock.calls.map((call: unknown[]) => call[0]))
      .toEqual([[1, 2, 3], [9, 9, 9]]);
    expect(backend.getCameraPose!()).toEqual({ position: [9, 9, 9], target: [0, 0, 0] });
  } finally { backend.dispose(); }
});

it('does not replay the recovered selection over a newer user selection', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    backend.selectTool!(7);
    runReplays();
    expect(replacement.selected).toBe(7);
    expect(replacement.selectTool.mock.calls.every((call: unknown[]) => call[0] === 7)).toBe(true);
  } finally { backend.dispose(); }
});

it('does not replay the recovered selection over a newer clear', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    backend.clearSelection!();
    expect(replacement.selected).toBeNull();
    runReplays();
    expect(replacement.selected).toBeNull();
    expect(replacement.selectTool).not.toHaveBeenCalled();
  } finally { backend.dispose(); }
});

it('clears pending replay timers on dispose and never restores into a disposed backend', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    expect(mocks.timers).toHaveLength(2);
    backend.dispose();
    expect(mocks.timers.every(timer => timer.cleared)).toBe(true);
    runReplays();
    expect(replacement.pose).toBeNull();
    expect(replacement.setCameraPose).not.toHaveBeenCalled();
    expect(backend.getCameraPose!()).toBeNull();
  } finally { backend.dispose(); }
});

it('cancels the previous replay when a newer recovery starts', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    // First recovery: replacement world has its own state; its replay is still pending.
    const secondWorld = queueWorld({ position: [7, 7, 7], target: [8, 8, 8] }, 9);
    await loseDevice();
    const stale = [...mocks.timers];
    expect(stale).toHaveLength(2);
    // A newer device loss starts before the stale replay fires and schedules a fresh replay.
    const thirdWorld = queueWorld(null, null);
    mocks.runtimes[mocks.runtimes.length - 1].options.onStatus?.('lost');
    await vi.waitFor(() => expect(activeTimers()).toHaveLength(2));
    expect(stale.every(timer => timer.cleared)).toBe(true);
    for (const timer of stale) timer.run();
    // The stale replay cannot write the first recovery's state into the newer world.
    expect(thirdWorld.pose).toBeNull();
    expect(thirdWorld.selectTool).not.toHaveBeenCalled();
    // The fresh replay for the second recovery still restores that recovery's preserved state.
    runReplays();
    expect(secondWorld.pose).toEqual({ position: [7, 7, 7], target: [8, 8, 8] });
    expect(thirdWorld.pose).toEqual({ position: [7, 7, 7], target: [8, 8, 8] });
    expect(thirdWorld.selected).toBe(9);
  } finally { backend.dispose(); }
});

it('keeps the recovered state when the page re-applies its ambient mode sequence after recovery', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    // twin-page.tsx status effect (~lines 409-418) runs on every viewer status update, including
    // the post-recovery 'ready' report, and re-applies the same ambient mode values. That must
    // stay idempotent or a normal recovery would cancel its own replay.
    backend.setXRayFilter!(null);
    backend.setLayer!('xray', false);
    backend.setBasement!(false);
    backend.setDual!(false);
    backend.setExplodeFactor!(0);
    backend.setCutPlane!(false, 'Y', 0, false);
    expect(activeTimers()).toHaveLength(2);
    runReplays();
    expect(replacement.pose).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
    expect(replacement.selected).toBe(42);
    expect(backend.getCameraPose!()).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
  } finally { backend.dispose(); }
});

it('keeps the recovered state when a non-default ambient mode is re-applied after recovery', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    // The user is in basement mode when the device is lost; the page re-applies basement=true
    // and dual=false (mutually exclusive world state) once the replacement world is ready.
    backend.setBasement!(true);
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    backend.setBasement!(true);
    backend.setDual!(false);
    expect(activeTimers()).toHaveLength(2);
    runReplays();
    expect(replacement.pose).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
  } finally { backend.dispose(); }
});

it('still cancels the delayed replay for a genuine mode change after recovery', async () => {
  const { backend } = await mountBackend({ position: [1, 2, 3], target: [4, 5, 6] }, 42);
  try {
    queueWorld(null, null);
    await loseDevice();
    const replacement = mocks.created[1];
    const pending = [...mocks.timers];
    // Basement was off before the loss, so this is a genuine false -> true user mode change.
    backend.setBasement!(true);
    expect(pending.every(timer => timer.cleared)).toBe(true);
    expect(activeTimers()).toHaveLength(0);
    runReplays();
    expect(replacement.pose).toBeNull();
    expect(replacement.selected).toBeNull();
    expect(replacement.setCameraPose).not.toHaveBeenCalled();
  } finally { backend.dispose(); }
});
