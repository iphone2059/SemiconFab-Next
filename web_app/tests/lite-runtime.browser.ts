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
  }
  const sizeBefore = await evaluate('__liteAcceptance.snapshot()');
  await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  const resized = await until(s => s.width !== sizeBefore.width && s.width === 1024 && s.height === 640, 'resize');
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
  return { status: 'PASS', scope: 'P1 cube lifecycle only; FAB parity NOT_RUN', gpu, initial, recoveries, resized, disposed, aborted, remounted };
}
