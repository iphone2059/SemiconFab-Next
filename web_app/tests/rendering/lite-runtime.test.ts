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
    registerShadows: vi.fn(async () => {}),
    startEngine: vi.fn(async () => {}),
    waitForGpuIdle: vi.fn(async () => {}),
  };
});
vi.mock('@babylonjs/lite', () => ({
  createEngine: gpu.createEngine,
  createSceneContext: () => { gpu.live.add('scene'); return { shadowGenerators: [], lights: [] }; },
  enableDeviceLostSceneRecovery: (_engine: unknown, callbacks: DeviceLostRecoveryCallbacks) => {
    gpu.recovery = callbacks; gpu.live.add('recovery');
    return { disable: () => { gpu.events.push('disable'); gpu.live.delete('recovery'); } };
  },
  registerScene: gpu.registerScene,
  registerSceneWithShadowSupport: gpu.registerShadows,
  startEngine: gpu.startEngine,
  waitForGpuIdle: gpu.waitForGpuIdle,
  stopEngine: () => { gpu.events.push('stop'); },
  disposeScene: () => { gpu.events.push('scene'); gpu.live.delete('scene'); },
  disposeEngine: () => { gpu.events.push('engine'); gpu.live.delete('engine'); },
}));

const native = await import('../../src/rendering/lite/runtime');
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
  vi.resetAllMocks(); gpu.live.clear(); gpu.events.length = 0; gpu.recovery = {};
  gpu.createEngine.mockImplementation(async () => { gpu.live.add('engine'); return {}; });
  gpu.registerScene.mockImplementation(async () => {});
  gpu.registerShadows.mockImplementation(async () => {});
  gpu.startEngine.mockImplementation(async () => {});
  gpu.waitForGpuIdle.mockImplementation(async () => {});
});

it('awaits feature preparation before the initial frame', async () => {
  const prepared = deferred();
  const runtime = createLiteRuntime(canvas, { compose() {}, beforeStart: () => prepared.promise });
  await vi.waitFor(() => expect(gpu.registerScene).toHaveBeenCalledOnce());
  expect(runtime.status).toBe('initializing');
  expect(gpu.startEngine).not.toHaveBeenCalled();
  prepared.resolve(); await runtime.ready;
  expect(runtime.status).toBe('ready');
  runtime.dispose(); expect(gpu.live.size).toBe(0);
});

it('keeps recovered feature registration owned until disposal can safely finish', async () => {
  const prepared = deferred(); let starts = 0;
  const runtime = createLiteRuntime(canvas, { compose() {},
    beforeStart: () => ++starts === 1 ? undefined : prepared.promise });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'loss with labels' });
  gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(starts).toBe(2));
  expect(runtime.status).toBe('lost');
  expect(gpu.startEngine).toHaveBeenCalledTimes(1);
  runtime.dispose();
  expect(gpu.live.has('engine')).toBe(true);
  prepared.resolve();
  await vi.waitFor(() => expect(gpu.live.size).toBe(0));
  expect(runtime.status).toBe('disposed');
  expect(gpu.startEngine).toHaveBeenCalledTimes(1);
});

it('fails and releases ownership when recovered feature preparation rejects', async () => {
  let starts = 0; let reported: unknown;
  const failure = new Error('label registration failed');
  const runtime = createLiteRuntime(canvas, { compose() {},
    beforeStart: () => { if (++starts > 1) throw failure; },
    onStatus: (_status, error) => { if (error) reported = error; } });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'loss' });
  gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(runtime.status).toBe('failed'));
  expect(reported).toBe(failure);
  expect(gpu.live.size).toBe(0);
  expect(gpu.startEngine).toHaveBeenCalledTimes(1);
});

it('does not restart a superseded feature recovery', async () => {
  const older = deferred(), latest = deferred(); let starts = 0;
  const runtime = createLiteRuntime(canvas, { compose() {}, beforeStart: () => {
    starts++; return starts === 2 ? older.promise : starts === 3 ? latest.promise : undefined;
  } });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'first loss' }); gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(starts).toBe(2));
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'second loss' }); gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(starts).toBe(3));
  older.resolve(); await Promise.resolve();
  expect(runtime.status).toBe('lost');
  expect(gpu.startEngine).toHaveBeenCalledTimes(1);
  latest.resolve(); await vi.waitFor(() => expect(runtime.status).toBe('ready'));
  expect(gpu.startEngine).toHaveBeenCalledTimes(2);
  runtime.dispose(); expect(gpu.live.size).toBe(0);
});

it.each(['ready', 'failed'] as const)('retains the engine when an older registration outlives the latest %s recovery and disposal', async outcome => {
  const older = deferred(), latest = deferred(); let starts = 0;
  const runtime = createLiteRuntime(canvas, { compose() {}, beforeStart: () => {
    starts++; return starts === 2 ? older.promise : starts === 3 ? latest.promise.then(() => {
      if (outcome === 'failed') throw new Error('latest registration failed');
    }) : undefined;
  } });
  await runtime.ready;
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'first loss' }); gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(starts).toBe(2));
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'second loss' }); gpu.recovery.onRecovered?.();
  await vi.waitFor(() => expect(starts).toBe(3));
  latest.resolve(); await vi.waitFor(() => expect(runtime.status).toBe(outcome));
  runtime.dispose();
  expect(gpu.live.has('engine')).toBe(true);
  older.resolve(); await vi.waitFor(() => expect(gpu.live.size).toBe(0));
  expect(runtime.status).toBe('disposed');
});

it('awaits native shadow registration before requesting a first frame', async () => {
  const compiled = deferred();
  gpu.registerShadows.mockReturnValue(compiled.promise);
  const runtime = createLiteRuntime(canvas, { compose(scene) { scene.shadowGenerators.push({}); } });
  await vi.waitFor(() => expect(gpu.registerShadows).toHaveBeenCalledOnce());
  expect(gpu.startEngine).not.toHaveBeenCalled();
  expect(gpu.registerScene).not.toHaveBeenCalled();
  compiled.resolve(); await runtime.ready;
  runtime.dispose(); expect(gpu.live.size).toBe(0);
});

it('releases all scene ownership when native shadow registration fails', async () => {
  gpu.registerShadows.mockRejectedValue(new Error('shadow compilation failed'));
  const runtime = createLiteRuntime(canvas, { compose(scene) { scene.shadowGenerators.push({}); } });
  await expect(runtime.ready).rejects.toThrow('shadow compilation failed');
  expect(gpu.startEngine).not.toHaveBeenCalled();
  expect(gpu.live.size).toBe(0);
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

it('waits for asynchronous scene composition before cleaning an aborted mount', async () => {
  const composition = deferred();
  const runtime = createLiteRuntime(canvas, { compose: async () => {
    gpu.live.add('controls');
    await composition.promise;
    return () => { gpu.live.delete('controls'); };
  } });
  await vi.waitFor(() => expect(gpu.live.has('controls')).toBe(true));
  runtime.dispose();
  expect(gpu.live.has('engine')).toBe(true);
  composition.resolve();
  await expect(runtime.ready).rejects.toMatchObject({ name: 'AbortError' });
  expect(gpu.registerScene).not.toHaveBeenCalled();
  expect(gpu.live.size).toBe(0);
});

it('releases the scene and engine when asynchronous composition rejects', async () => {
  const failure = new Error('environment upload rejected');
  const runtime = createLiteRuntime(canvas, { compose: async () => { throw failure; } });
  await expect(runtime.ready).rejects.toBe(failure);
  expect(runtime.status).toBe('failed');
  expect(gpu.live.size).toBe(0);
});

it.each(['before-compose-settles', 'after-compose-settles'] as const)(
  'fails a device loss during asynchronous composition and retains ownership until recovery finishes %s', async order => {
    const composition = deferred();
    const runtime = createLiteRuntime(canvas, { compose: async () => {
      gpu.live.add('controls'); await composition.promise;
      return () => { gpu.live.delete('controls'); };
    } });
    await vi.waitFor(() => expect(gpu.live.has('controls')).toBe(true));
    gpu.recovery.onLost?.({ reason: 'unknown', message: 'device lost during HDR upload' });
    if (order === 'before-compose-settles') gpu.recovery.onRecovered?.();
    expect(gpu.live.has('engine')).toBe(true);
    composition.resolve();
    await expect(runtime.ready).rejects.toThrow('WebGPU device lost before scene registration completed');
    expect(gpu.registerScene).not.toHaveBeenCalled();
    expect(gpu.startEngine).not.toHaveBeenCalled();
    if (order === 'after-compose-settles') {
      expect(gpu.live.has('engine')).toBe(true);
      gpu.recovery.onRecovered?.();
    }
    expect(runtime.status).toBe('failed');
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
  await vi.waitFor(() => expect(runtime.status).toBe('ready'));
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
  expect(gpu.events).toEqual(['stop']);
  if (outcome === 'recover') gpu.recovery.onRecovered?.();
  else gpu.recovery.onRecoveryFailed?.(new Error('replacement failed'));
  expect(gpu.live.size).toBe(0);
  expect(states).toEqual(['initializing', 'ready', 'lost']);
});

it('finishes initialization from a recovered first frame when the original RAF was canceled', async () => {
  gpu.startEngine.mockReturnValueOnce(new Promise(() => {}));
  const runtime = createLiteRuntime(canvas, { compose: () => {} });
  await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledOnce());
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'first frame lost' });
  gpu.recovery.onRecovered?.();
  const result = await Promise.race([runtime.ready.then(() => 'ready'), new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
  expect(result).toBe('ready');
  runtime.dispose();
});

it('stops old-device frames before lost observers reset resources and waits for replacement GPU completion', async () => {
  const resumed = deferred(), submitted = deferred();
  const runtime = createLiteRuntime(canvas, {
    compose: () => {},
    onStatus: status => { if (status === 'lost') gpu.events.push('reset-instance-state'); },
  });
  await runtime.ready;
  gpu.startEngine.mockReturnValueOnce(resumed.promise);
  gpu.waitForGpuIdle.mockReturnValueOnce(submitted.promise);
  gpu.recovery.onLost?.({ reason: 'unknown', message: 'instance buffers lost' });
  expect(gpu.events).toEqual(['stop', 'reset-instance-state']);
  gpu.recovery.onRecovered?.();
  expect(runtime.status).toBe('lost');
  resumed.resolve();
  await vi.waitFor(() => expect(gpu.waitForGpuIdle).toHaveBeenCalledTimes(2));
  expect(runtime.status).toBe('lost');
  submitted.resolve();
  await vi.waitFor(() => expect(runtime.status).toBe('ready'));
  runtime.dispose();
});

it('settles initialization when a second device loss interrupts the replacement first frame', async () => {
  let rejectSubmission!: (error: Error) => void;
  gpu.waitForGpuIdle.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSubmission = reject; }));
  const runtime = createLiteRuntime(canvas, { compose: () => {} });
  try {
    await vi.waitFor(() => expect(gpu.waitForGpuIdle).toHaveBeenCalledOnce());
    gpu.recovery.onLost?.({ reason: 'unknown', message: 'initial submission lost' });
    rejectSubmission(new Error('old device lost'));
    // Model native recovery arriving in a later turn, after the rejected submission's
    // microtasks have moved initialization onto the first recovery barrier.
    await new Promise(resolve => setTimeout(resolve, 0));
    gpu.startEngine.mockReturnValueOnce(new Promise(() => {}));
    gpu.recovery.onRecovered?.();
    await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledTimes(2));
    gpu.recovery.onLost?.({ reason: 'unknown', message: 'replacement RAF lost' });
    gpu.recovery.onRecovered?.();
    await vi.waitFor(() => expect(gpu.startEngine).toHaveBeenCalledTimes(3));
    const result = await Promise.race([runtime.ready.then(() => 'ready'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
    expect(result).toBe('ready');
    expect(runtime.status).toBe('ready');
  } finally { runtime.dispose(); }
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
  // Original submission, explicit resumed-frame completion, then initialization's final generation check.
  expect(gpu.waitForGpuIdle).toHaveBeenCalledTimes(3);
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
