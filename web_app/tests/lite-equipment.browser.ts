// @ts-nocheck — test-only real WebGPU acceptance through the existing CDP runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function runLiteEquipmentAcceptance(command, baseUrl) {
  const reference = JSON.parse(fs.readFileSync(new URL('../../docs/migration/twin-parity/layout-identities.json', import.meta.url)));
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  async function until(predicate, stage) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const snapshot = await evaluate('window.__liteAcceptance?.snapshot()');
      if (snapshot?.gpuErrors.length) throw new Error(JSON.stringify(snapshot));
      if (snapshot && predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + stage);
  }
  function check(snapshot) {
    assert.equal(snapshot.equipment.tools, 121);
    assert.ok(snapshot.equipment.batches < 121);
    assert.equal(snapshot.meshes, snapshot.equipment.batches);
    assert.ok(snapshot.drawCalls > 0);
    assert.equal(snapshot.registeredContexts, 1);
    assert.deepEqual(snapshot.equipment.identities, reference.map(row => ({
      instanceId: row.instance_id, recordId: row.record_id, mapped: true,
    })));
  }
  await command('Page.navigate', { url: baseUrl + '/?scene=equipment' });
  const initial = await until(s => s.status === 'ready' && s.frames > 2, 'equipment first frame');
  check(initial);
  console.log(`Lite equipment: ${initial.equipment.tools} placements / ${initial.equipment.batches} batches / ${initial.equipment.instances} part instances`);
  const gpu = await evaluate(`(async () => { const adapter = await navigator.gpu.requestAdapter(); return {
    vendor: adapter.info.vendor, architecture: adapter.info.architecture, userAgent: navigator.userAgent,
  }; })()`);
  const iso = await command('Page.captureScreenshot', { format: 'png' });
  const recoveries = [];
  for (let loss = 1; loss <= 3; loss++) {
    await evaluate('__liteAcceptance.loseDevice()');
    const recovered = await until(s => s.status === 'ready' && s.states.filter(state => state === 'lost').length === loss
      && s.states.filter(state => state === 'ready').length === loss + 1, `equipment recovery ${loss}`);
    const resumed = await until(s => s.frames > recovered.frames + 2, 'resumed equipment frames');
    check(resumed);
    recoveries.push(resumed);
    console.log(`Lite equipment: recovery ${loss} ready`);
  }
  await evaluate('__liteAcceptance.topView()');
  const top = await until(s => s.frames > recoveries[2].frames + 3, 'top equipment frame');
  const topImage = await command('Page.captureScreenshot', { format: 'png' });
  const disposed = await evaluate('__liteAcceptance.dispose()');
  assert.equal(disposed.meshes, 0);
  assert.equal(disposed.registeredContexts, 0);
  assert.equal(disposed.surfaces, 0);
  const remounted = await evaluate('__liteAcceptance.mount()');
  check(remounted);
  await until(s => s.frames > remounted.frames + 2, 'remounted equipment frames');
  // The output directory is supplied explicitly; no test files are overwritten by default.
  if (process.env.LITE_EVIDENCE_DIR) {
    fs.writeFileSync(process.env.LITE_EVIDENCE_DIR + '/p2-equipment-iso.png', Buffer.from(iso.data, 'base64'));
    fs.writeFileSync(process.env.LITE_EVIDENCE_DIR + '/p2-equipment-top.png', Buffer.from(topImage.data, 'base64'));
  }
  return { status: 'PASS', scope: 'P2 equipment geometry only; full FAB/lighting/picking parity NOT_RUN',
    gpu, initial, recoveries, top, disposed, remounted };
}
