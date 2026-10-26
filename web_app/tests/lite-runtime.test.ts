import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceLostRecoveryCallbacks } from '@babylonjs/lite';

// GPU acquisition/compilation needs a real browser; only that boundary is doubled here.
const gpu = vi.hoisted(() => {
  const live = new Set<string>();
  return {
    live,
    events: [] as string[],
    recovery: {} as DeviceLostRecoveryCallbacks,
    createEngine: vi.fn(async () => { live.add('engine'); return {}; }),
    registerScene: vi.fn(async () => {}),
    startEngine: vi.fn(async () => {}),
    waitForGpuIdle: vi.fn(async () => {}),
  };
});
vi.mock('@babylonjs/lite', () => ({
  createEngine: gpu.createEngine,
  createSceneContext: () => { gpu.live.add('scene'); return {}; },
  enableDeviceLostSceneRecovery: (_engine: unknown, callbacks: DeviceLostRecoveryCallbacks) => {
    gpu.recovery = callbacks; gpu.live.add('recovery');
    return { disable: () => { gpu.events.push('disable'); gpu.live.delete('recovery'); } };
  },
  registerScene: gpu.registerScene,
  startEngine: gpu.startEngine,
  waitForGpuIdle: gpu.waitForGpuIdle,
  stopEngine: () => { gpu.events.push('stop'); },
  disposeScene: () => { gpu.events.push('scene'); gpu.live.delete('scene'); },
  disposeEngine: () => { gpu.events.push('engine'); gpu.live.delete('engine'); },
}));

const native = await import('../src/render/lite/runtime');
function createLiteRuntime(...args: Parameters<typeof native.createLiteRuntime>) {
  const runtime = native.createLiteRuntime(...args);
  // A mount can be canceled before its owner reaches the await below.
  void runtime.ready.catch(() => {});
  return runtime;
}
const canvas = {} as HTMLCanvasElement;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); gpu.live.clear(); gpu.events.length = 0; gpu.recovery = {};
  gpu.createEngine.mockImplementation(async () => { gpu.live.add('engine'); return {}; });
  gpu.registerScene.mockImplementation(async () => {});
  gpu.startEngine.mockImplementation(async () => {});
  gpu.waitForGpuIdle.mockImplementation(async () => {});
});

it('reports ready only after first-frame GPU completion and releases resources exactly once', async () => {
  const firstFrame = deferred(); const submitted = deferred(); const states: string[] = [];
  gpu.startEngine.mockReturnValue(firstFrame.promise);
  gpu.waitForGpuIdle.mockReturnValue(submitted.promise);
  const runtime = createLiteRuntime(canvas, {
    compose: () => { gpu.live.add('controls'); return () => { gpu.events.push('controls'); gpu.live.delete('controls'); }; },
    onStatus: status => states.push(status),
  });
  await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledOnce());
  expect(states).toEqual(['initializing']);
  firstFrame.resolve();
  await vi.waitFor(() => expect(gpu.waitForGpuIdle).toHaveBeenCalledOnce());
  expect(states).toEqual(['initializing']);
  submitted.resolve(); await runtime.ready;
  expect(runtime.status).toBe('ready');
  expect(states).toEqual(['initializing', 'ready']);
  runtime.dispose(); runtime.dispose();
  expect(gpu.live.size).toBe(0);
  expect(gpu.events).toEqual(['stop', 'disable', 'controls', 'scene', 'engine']);
});

it('does not acquire a device when the mount signal is already aborted', async () => {
  const controller = new AbortController(); controller.abort();
  const runtime = createLiteRuntime(canvas, { signal: controller.signal, compose: () => {} });
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(gpu.createEngine).not.toHaveBeenCalled();
  expect(gpu.live.size).toBe(0);
});

it.each(['create', 'register'] as const)('defers cleanup during pending %s and never starts stale work', async stage => {
  const pending = deferred(); const states: string[] = [];
  if (stage === 'create') gpu.createEngine.mockImplementation(async () => { await pending.promise; gpu.live.add('engine'); return {}; });
  else gpu.registerScene.mockReturnValue(pending.promise);
  const runtime = createLiteRuntime(canvas, { compose: () => {}, onStatus: state => states.push(state) });
  if (stage === 'register') await vi.waitFor(() => expect(gpu.registerScene).toHaveBeenCalledOnce());
  runtime.dispose();
  expect(gpu.events).toEqual([]);
  pending.resolve();
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(gpu.startEngine).not.toHaveBeenCalled();
  expect(gpu.live.size).toBe(0);
  expect(states).toEqual(['initializing']);
});

it('cancels a first-frame wait even when stopping RAF cannot settle the engine promise', async () => {
  gpu.startEngine.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const runtime = createLiteRuntime(canvas, { signal: controller.signal, compose: () => {} });
  await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledOnce());
  controller.abort();
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(runtime.status).toBe('disposed');
  expect(gpu.live.size).toBe(0);
});

it.each(['compose', 'register', 'submit'] as const)('cleans partially initialized resources after a %s failure', async stage => {
  const failure = new Error('GPU setup rejected'); const states: string[] = [];
  if (stage === 'register') gpu.registerScene.mockRejectedValue(failure);
  if (stage === 'submit') gpu.waitForGpuIdle.mockRejectedValue(failure);
  const runtime = createLiteRuntime(canvas, {
    compose: () => { if (stage === 'compose') throw failure; },
    onStatus: status => states.push(status),
  });
  await expect(runtime.ready).rejects.toBe(failure);
  expect(runtime.status).toBe('failed');
  expect(states).toEqual(['initializing', 'failed']);
  expect(gpu.live.size).toBe(0);
});

it('forwards native recovery and suppresses late callbacks after disposal', async () => {
  const states: string[] = [];
  const runtime = createLiteRuntime(canvas, { compose: () => {}, onStatus: status => states.push(status) });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'test loss' });
  expect(runtime.status).toBe('lost');
  gpu.recovery.onRecovered?.();
  expect(runtime.status).toBe('ready');
  runtime.dispose();
  gpu.recovery.onLost?.({ reason: 'destroyed', message: '' });
  gpu.recovery.onRecovered?.(); gpu.recovery.onRecoveryFailed?.(new Error('late'));
  expect(states).toEqual(['initializing', 'ready', 'lost', 'ready']);
  expect(runtime.status).toBe('disposed');
});

it('releases a failed recovery and reports the failure to the owner', async () => {
  let reported: unknown;
  const runtime = createLiteRuntime(canvas, { compose: () => {}, onStatus: (_status, error) => { reported = error; } });
  await runtime.ready;
  const error = new Error('replacement device unavailable');
  gpu.recovery.onRecoveryFailed?.(error);
  expect(runtime.status).toBe('failed');
  expect(reported).toBe(error);
  expect(gpu.live.size).toBe(0);
});

it.each(['recover', 'fail'] as const)('waits for in-flight recovery to %s before disposing its replacement device', async outcome => {
  const states: string[] = [];
  const runtime = createLiteRuntime(canvas, { compose: () => {}, onStatus: status => states.push(status) });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'test loss' });
  runtime.dispose();
  expect(runtime.status).toBe('disposed');
  // Lite disable() cannot cancel a captured requestAdapter/requestDevice operation.
  expect(gpu.live.has('engine')).toBe(true);
  expect(gpu.events).toEqual([]);
  if (outcome === 'recover') gpu.recovery.onRecovered?.();
  else gpu.recovery.onRecoveryFailed?.(new Error('replacement failed'));
  expect(gpu.live.size).toBe(0);
  expect(states).toEqual(['initializing', 'ready', 'lost']);
});

it('finishes initialization from a recovered first frame when the original RAF was canceled', async () => {
  gpu.startEngine.mockReturnValue(new Promise(() => {}));
  const runtime = createLiteRuntime(canvas, { compose: () => {} });
  await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledOnce());
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'first frame lost' });
  gpu.recovery.onRecovered?.();
  const result = await Promise.race([runtime.ready.then(() => 'ready'), new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
  expect(result).toBe('ready');
  runtime.dispose();
});

it('rechecks cancellation after a ready observer synchronously aborts its owner', async () => {
  const controller = new AbortController();
  const runtime = createLiteRuntime(canvas, {
    signal: controller.signal, compose: () => {},
    onStatus: status => { if (status === 'ready') controller.abort(); },
  });
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(gpu.live.size).toBe(0);
});

it('retries the first-frame GPU boundary on the replacement device after loss during submission', async () => {
  let rejectSubmission!: (error: Error) => void;
  gpu.waitForGpuIdle.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSubmission = reject; }));
  const runtime = createLiteRuntime(canvas, { compose: () => {} });
  await vi.waitFor(() => expect(gpu.waitForGpuIdle).toHaveBeenCalledOnce());
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'submitted device lost' });
  rejectSubmission(new Error('old device lost'));
  gpu.recovery.onRecovered?.();
  await runtime.ready;
  expect(gpu.waitForGpuIdle).toHaveBeenCalledTimes(2);
  expect(runtime.status).toBe('ready');
  runtime.dispose();
});

it('avoids acquiring a device when an initializing observer synchronously aborts the mount', async () => {
  const controller = new AbortController();
  const runtime = createLiteRuntime(canvas, {
    signal: controller.signal, compose: () => {},
    onStatus: status => { if (status === 'initializing') controller.abort(); },
  });
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(gpu.createEngine).not.toHaveBeenCalled();
});

it('releases replacement resources after initialization fails during native recovery', async () => {
  const registration = deferred();
  const failure = new Error('registration rejected');
  gpu.registerScene.mockImplementation(async () => { await registration.promise; throw failure; });
  const runtime = createLiteRuntime(canvas, { compose: () => {} });
  await vi.waitFor(() => expect(gpu.registerScene).toHaveBeenCalledOnce());
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'registration device lost' });
  registration.resolve();
  await expect(runtime.ready).rejects.toBe(failure);
  expect(gpu.live.has('engine')).toBe(true);
  gpu.recovery.onRecovered?.();
  expect(gpu.live.size).toBe(0);
  expect(runtime.status).toBe('failed');
});
