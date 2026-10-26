// @ts-nocheck — standalone CDP acceptance using a caller-supplied browser transport.
import assert from 'node:assert/strict';

export async function runLiteRuntimeAcceptance(command, baseUrl) {
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  async function until(predicate, description) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const snapshot = await evaluate('window.__liteAcceptance?.snapshot()');
      if (snapshot?.gpuErrors.length) throw new Error(JSON.stringify(snapshot));
      if (snapshot && predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + description);
  }
  await command('Page.navigate', { url: baseUrl });
  const initial = await until(s => s.status === 'ready' && s.frames > 2, 'initial Lite frame');
  console.log('Lite acceptance: initial frame ready');
  assert.equal(initial.meshes, 1);
  assert.ok(initial.drawCalls > 0);
  assert.equal(initial.registeredContexts, 1);
  const gpu = await evaluate(`(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return { secure: isSecureContext, vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, userAgent: navigator.userAgent };
  })()`);

  const recoveries = [];
  for (let loss = 1; loss <= 3; loss++) {
    await evaluate('__liteAcceptance.loseDevice()');
    const recovered = await until(s => s.status === 'ready' && s.states.filter(state => state === 'lost').length === loss
      && s.states.filter(state => state === 'ready').length === loss + 1, `device recovery ${loss}`);
    await until(s => s.frames > recovered.frames + 2, 'resumed frames');
    recoveries.push(recovered);
    console.log(`Lite acceptance: recovery ${loss} ready`);
  }
  const sizeBefore = await evaluate('__liteAcceptance.snapshot()');
  await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  const resized = await until(s => s.width !== sizeBefore.width && s.width === 1024 && s.height === 640, 'resize');
  console.log('Lite acceptance: resized');
  const disposalDuringRecovery = await evaluate(`(async () => {
    const original = navigator.gpu.requestAdapter;
    let release;
    let notify;
    const requested = new Promise(resolve => { notify = resolve; });
    navigator.gpu.requestAdapter = function(...args) {
      return new Promise((resolve, reject) => {
        release = () => Reflect.apply(original, this, args).then(resolve, reject);
        notify();
      });
    };
    try {
      __liteAcceptance.loseDevice();
      await requested;
      const pending = __liteAcceptance.dispose();
      release();
      return pending;
    } finally { navigator.gpu.requestAdapter = original; }
  })()`);
  assert.equal(disposalDuringRecovery.status, 'disposed');
  console.log('Lite acceptance: disposed while replacement acquisition pending');
  assert.equal(disposalDuringRecovery.surfaces, 1, 'replacement acquisition still owns resources');
  await until(s => s.surfaces === 0, 'dispose after native recovery settles');
  console.log('Lite acceptance: replacement resources released');
  // A committed PNG is collected by the runner separately; this suite checks actual rendering/lifetime state.
  const disposed = await evaluate('__liteAcceptance.dispose()');
  assert.equal(disposed.status, 'disposed');
  assert.equal(disposed.registeredContexts, 0);
  assert.equal(disposed.surfaces, 0);
  assert.equal(disposed.meshes, 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await evaluate('__liteAcceptance.snapshot()')).frames, disposed.frames);
  const aborted = await evaluate('__liteAcceptance.mount(true)');
  assert.equal(aborted.status, 'disposed');
  assert.equal(aborted.registeredContexts, 0);
  const remounted = await evaluate('__liteAcceptance.mount()');
  assert.equal(remounted.status, 'ready');
  assert.equal(remounted.registeredContexts, 1);
  assert.equal(remounted.meshes, 1);
  await until(s => s.frames > remounted.frames + 2, 'remounted frames');
  console.log('Lite acceptance: remounted');
  const firstFrameLoss = await evaluate(`(async () => {
    __liteAcceptance.dispose();
    const original = window.requestAnimationFrame;
    let interrupted = false;
    window.requestAnimationFrame = function(callback) {
      if (!interrupted) { interrupted = true; queueMicrotask(() => __liteAcceptance.loseDevice()); }
      return original.call(window, callback);
    };
    try {
      return await Promise.race([__liteAcceptance.mount(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('first-frame recovery hung')), 30000))]);
    } finally { window.requestAnimationFrame = original; }
  })()`);
  assert.equal(firstFrameLoss.status, 'ready');
  assert.equal(firstFrameLoss.states.filter(s => s === 'lost').length, 5);
  return { status: 'PASS', scope: 'P1 cube lifecycle only; FAB parity NOT_RUN', gpu, initial, recoveries, resized, disposalDuringRecovery, disposed, aborted, remounted, firstFrameLoss };
}
