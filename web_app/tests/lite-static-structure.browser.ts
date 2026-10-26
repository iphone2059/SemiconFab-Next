// @ts-nocheck — real GPU acceptance, run against the isolated built Lite fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
export async function runLiteStaticStructureAcceptance(command, baseUrl) {
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(predicate, stage) {
    const deadline = Date.now() + 30000;
    let last;
    while (Date.now() < deadline) {
      const snapshot = await evaluate('window.__liteAcceptance?.snapshot()');
      last = snapshot;
      if (snapshot?.gpuErrors.length) throw new Error(JSON.stringify({ stage, status: snapshot.status, errors: snapshot.gpuErrors }));
      if (snapshot && predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + stage + ' ' + JSON.stringify({ status: last?.status, loadingStage: last?.loadingStage,
      frames: last?.frames, meshes: last?.meshes, errors: last?.gpuErrors }));
  }
  const screenshots = [];
  async function capture(name) {
    if (!process.env.LITE_EVIDENCE_DIR) return;
    const image = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${process.env.LITE_EVIDENCE_DIR}/p2b-${name}.png`, Buffer.from(image.data, 'base64'));
    screenshots.push(name);
  }
  await command('Page.navigate', { url: baseUrl + '/?scene=structure' });
  const initial = await until(s => s.status === 'ready' && s.frames > 2, 'static first frame');
  assert.equal(initial.structure.parts, 1648);
  assert.equal(initial.structure.lights, 10);
  assert.equal(initial.equipment.tools, 121);
  assert.ok(initial.equipment.identities.every(identity => identity.mapped));
  assert.equal(initial.meshes, initial.structure.batches + initial.equipment.batches);
  assert.equal(initial.structure.textures.length, 2);
  assert.ok(initial.structure.textures.every(texture => texture.metadata.format === 'rgba8unorm'
    && texture.metadata.mipLevelCount === 10));
  assert.deepEqual(initial.structure.textures.map(texture => [texture.transform.uScale, texture.transform.vScale]).sort(), [[28, 60], [95, 70]]);
  await capture('l1');
  const views = [];
  for (const view of ['ffu', 'b1', 'dual', 'l1']) {
    const before = await evaluate('__liteAcceptance.snapshot().frames');
    await evaluate(`__liteAcceptance.structureView('${view}')`);
    const state = await until(s => s.frames > before + 2, view);
    assert.equal(state.structure.layers.ffu.visible, view === 'ffu');
    assert.equal(state.structure.layers.b1.visible, view === 'b1' || view === 'dual');
    assert.equal(state.structure.layers.shell.visible, view !== 'b1');
    assert.equal(state.structure.layers.b1.offset, view === 'dual' ? -18 : 0);
    assert.ok(state.drawCalls > 0);
    views.push({ view, state });
    await capture(view);
  }
  const recoveries = [];
  await evaluate("__liteAcceptance.structureView('dual')");
  for (let loss = 1; loss <= 3; loss++) {
    await evaluate('__liteAcceptance.loseDevice()');
    const recovered = await until(s => s.status === 'ready' && s.states.filter(state => state === 'lost').length === loss,
      `static recovery ${loss}`);
    const state = await until(s => s.frames > recovered.frames + 2, 'resumed static frame');
    assert.equal(state.structure.layers.b1.offset, -18);
    assert.equal(state.structure.parts, 1648);
    assert.equal(state.meshes, initial.meshes);
    recoveries.push(state);
    console.log(`Lite static: recovery ${loss} PASS`);
  }
  const disposed = await evaluate('__liteAcceptance.dispose()');
  assert.equal(disposed.meshes, 0); assert.equal(disposed.registeredContexts, 0); assert.equal(disposed.surfaces, 0);
  const remounted = await evaluate('__liteAcceptance.mount()');
  assert.equal(remounted.status, 'ready'); assert.equal(remounted.meshes, initial.meshes);
  await until(s => s.frames > remounted.frames + 2, 'remounted static frame');
  const gpu = await evaluate(`(async()=>{const adapter=await navigator.gpu.requestAdapter();return {
    vendor:adapter.info.vendor,architecture:adapter.info.architecture,userAgent:navigator.userAgent};})()`);
  return { status: 'PASS', scope: 'P2 static geometry only; P3 product backend/picking and P4 pixel parity NOT_RUN',
    gpu, initial, views, recoveries, disposed, remounted, screenshots };
}
