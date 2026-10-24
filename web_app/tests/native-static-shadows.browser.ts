// @ts-nocheck — executable CDP acceptance, using a supplied browser transport.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Run through a connected tab's CDP capability; no browser process or fallback renderer. */
export async function runNativeShadowAcceptance(command) {
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  await evaluate(`(async () => {
    const entry = performance.getEntriesByType('resource').findLast(r => r.name.includes('/@babylonjs_core_Engines_webgpuEngine.js')).name;
    const source = await (await fetch(entry)).text();
    const path = source.match(/import \\{[^}]* as EngineStore[^}]*\\} from "([^"]+)"/)[1];
    const url = new URL(path, entry).href;
    const exports = await import(url);
    const store = Object.values(exports).find(value => typeof value === 'function' && 'LastCreatedScene' in value);
    const deadline = performance.now() + 20000;
    while (!store.LastCreatedScene?.metadata?.staticShadows) {
      if (performance.now() > deadline) throw new Error('Native shadow scene did not become ready');
      await new Promise(requestAnimationFrame);
    }
    const scene = store.LastCreatedScene;
    const engine = scene.getEngine();
    const shadow = scene.metadata.staticShadows;
    const errors = [];
    const onError = event => errors.push(event.error.message);
    engine._device.addEventListener('uncapturederror', onError);
    window.__fabShadowAcceptance = { scene, engine, shadow, errors, onError,
      cameraAlpha: scene.activeCamera.alpha,
      frames: async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); } };
  })()`);
  try {
    const initial = await evaluate(`__fabShadowAcceptance.shadow.stats`);
    assert.equal(initial.format, 'depth32float');
    assert.equal(initial.size, 2048);
    assert.ok(initial.casterCount > 121);
    assert.ok(initial.triangleCount > 10000);
    assert.equal(await evaluate(`__fabShadowAcceptance.scene.meshes.some(m => m.name.includes('baked-tool'))`), false);
    await evaluate(`__fabShadowAcceptance.frames(12)`);
    assert.equal(await evaluate(`__fabShadowAcceptance.shadow.stats.passes`), initial.passes, 'static depth must stay cached');
    await evaluate(`__fabShadowAcceptance.scene.activeCamera.alpha += 0.15; __fabShadowAcceptance.frames(8)`);
    assert.equal(await evaluate(`__fabShadowAcceptance.shadow.stats.passes`), initial.passes, 'camera must not invalidate static depth');

    const moved = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      const root = t.scene.getTransformNodeByName('procedural-equipment');
      root.position.y = 2.4;
      await t.frames();
      const moved = t.shadow.stats.passes;
      root.position.y = 0;
      await t.frames();
      return { moved, restored: t.shadow.stats.passes };
    })()`);
    assert.equal(moved.moved, initial.passes + 1);
    assert.equal(moved.restored, initial.passes + 2);
    const layer = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      const root = t.scene.getTransformNodeByName('procedural-ceiling');
      const enabled = root.isEnabled();
      root.setEnabled(!enabled); await t.frames();
      const changed = t.shadow.stats.passes;
      root.setEnabled(enabled); await t.frames();
      return { changed, restored: t.shadow.stats.passes };
    })()`);
    assert.equal(layer.changed, moved.restored + 1);
    assert.equal(layer.restored, moved.restored + 2);

    const light = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      const light = t.scene.getLightByName('native-key');
      const original = light.direction.clone();
      light.direction.x += 0.1; await t.frames();
      const changed = t.shadow.stats.passes;
      light.direction.copyFrom(original); await t.frames();
      return { changed, restored: t.shadow.stats.passes,
        firstLight: t.scene.getMeshByName('procedural-floor').lightSources[0].name };
    })()`);
    assert.equal(light.changed, layer.restored + 1);
    assert.equal(light.restored, layer.restored + 2);
    assert.equal(light.firstLight, 'native-key');

    const geometry = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      const mesh = t.scene.meshes.find(m => m.name === 'original-tool-0-part-1');
      if (!mesh || !mesh.geometry) throw new Error('geometry caster missing');
      const positions = Float32Array.from(mesh.getVerticesData('position'));
      const original = positions[0];
      positions[0] = original + 0.002;
      mesh.geometry.setVerticesData('position', positions, true);
      await t.frames();
      const changed = t.shadow.stats.passes;
      positions[0] = original;
      mesh.geometry.setVerticesData('position', positions, true);
      await t.frames();
      return { changed, restored: t.shadow.stats.passes };
    })()`);
    assert.equal(geometry.changed, light.restored + 1, 'geometry mutation must invalidate static depth');
    assert.equal(geometry.restored, light.restored + 2);

    const pixels = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      t.scene.activeCamera.alpha = t.cameraAlpha;
      await t.frames();
      const width = t.engine.getRenderWidth(), height = t.engine.getRenderHeight();
      t.shadow.enabled = true; await t.frames();
      const shaded = await t.engine.readPixels(0, 0, width, height);
      t.shadow.enabled = false; await t.frames();
      const clear = await t.engine.readPixels(0, 0, width, height);
      t.shadow.enabled = true; await t.frames();
      let darkenedPixels = 0, channelReduction = 0;
      for (let i = 0; i < shaded.length; i += 4) {
        const delta = clear[i] + clear[i+1] + clear[i+2] - shaded[i] - shaded[i+1] - shaded[i+2];
        if (delta > 24) { darkenedPixels++; channelReduction += delta; }
      }
      return { width, height, byteLength: shaded.length, darkenedPixels,
        meanReduction: channelReduction / Math.max(1, darkenedPixels), errors: t.errors,
        finalPasses: t.shadow.stats.passes };
    })()`);
    assert.ok(pixels.byteLength > 0, 'must read actual GPU color pixels');
    assert.ok(pixels.darkenedPixels > pixels.width * pixels.height * 0.003, 'native receiver must visibly darken the floor');
    assert.ok(pixels.meanReduction > 24, 'shadow contrast must be measurable');
    assert.equal(JSON.stringify(pixels.errors), '[]', 'GPU validation must remain clean');
    const ambient = await evaluate(`(async () => {
      const t = __fabShadowAcceptance;
      const light = t.scene.getLightByName('native-key');
      const intensity = light.intensity;
      const dynamic = ['native-amhs', 'procedural-personnel'].map(name => t.scene.getTransformNodeByName(name));
      const enabled = dynamic.map(node => node.isEnabled());
      try {
        dynamic.forEach(node => node.setEnabled(false));
        light.intensity = 0; await t.frames();
        const width = t.engine.getRenderWidth(), height = t.engine.getRenderHeight();
        t.shadow.enabled = true; await t.frames();
        const enabled = await t.engine.readPixels(0, 0, width, height);
        t.shadow.enabled = false; await t.frames();
        const disabled = await t.engine.readPixels(0, 0, width, height);
        let changedPixels = 0;
        for (let i = 0; i < enabled.length; i += 4) {
          const delta = Math.abs(enabled[i]-disabled[i]) + Math.abs(enabled[i+1]-disabled[i+1]) + Math.abs(enabled[i+2]-disabled[i+2]);
          if (delta > 24) changedPixels++;
        }
        return { changedPixels, width, height };
      } finally {
        dynamic.forEach((node, index) => node.setEnabled(enabled[index]));
        light.intensity = intensity; t.shadow.enabled = true; await t.frames();
      }
    })()`);
    assert.ok(ambient.changedPixels < ambient.width * ambient.height * 0.0005, 'ambient/fill must not be shadowed (allow status-lamp updates)');
    return { initial, moved, layer, light, geometry, pixels, ambient };
  } finally {
    await evaluate(`(() => {
      const t = window.__fabShadowAcceptance;
      t.scene.activeCamera.alpha = t.cameraAlpha;
      t.scene.getTransformNodeByName('procedural-equipment').position.y = 0;
      t.shadow.enabled = true;
      t.engine._device.removeEventListener('uncapturederror', t.onError);
      delete window.__fabShadowAcceptance;
    })()`);
  }
}

// Also runnable directly against a developer-owned isolated browser.
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.CDP_PORT ?? '9335';
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find(tab => tab.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):5173\/twin/.test(tab.url));
  assert.ok(tab, 'Open the local /twin page in the isolated CDP browser first');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const runtimeErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') runtimeErrors.push(message.params.entry.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await command('Runtime.enable'); await command('Log.enable');
    const result = await runNativeShadowAcceptance(command);
    assert.deepEqual(runtimeErrors, []);
    console.log(JSON.stringify(result, null, 2));
  } finally { socket.close(); }
}
