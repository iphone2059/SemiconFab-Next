// @ts-nocheck — executable CDP acceptance, using a supplied browser transport.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function decodePng(buffer: Buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG signature mismatch');
  let offset = 8; let width = 0; let height = 0; let colorType = 0; let bitDepth = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('Unsupported PNG format');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]; position += 1;
    const row = raw.subarray(position, position + stride); position += stride;
    const previous = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    const target = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? target[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      target[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function imageDiff(a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>) {
  const x0 = Math.floor(a.width * 0.1); const x1 = Math.floor(a.width * 0.9);
  const y0 = Math.floor(a.height * 0.15); const y1 = Math.floor(a.height * 0.85);
  let sum = 0; let changed = 0; let pixels = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      const delta = Math.abs(a.data[ia] - b.data[ib]) + Math.abs(a.data[ia + 1] - b.data[ib + 1]) + Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      sum += delta; if (delta > 6) changed += 1; pixels += 1;
    }
  }
  return { mean: sum / (pixels * 3), changedFraction: changed / pixels };
}

const PAGE_SETUP = `(async () => {
  const perf = window.__SEMICONFAB_PERF__;
  let scene;
  if (perf?.getScene) {
    scene = perf.getScene();
  } else {
  const quote = String.fromCharCode(34);
  const entry = performance.getEntriesByType('resource').findLast(r => r.name.includes('/@babylonjs_core_Engines_webgpuEngine.js')).name;
  const source = await (await fetch(entry)).text();
  const markerAt = source.indexOf(' as EngineStore');
  const fromAt = source.indexOf('from ' + quote, markerAt);
  const pathStart = fromAt + 6;
  const pathEnd = source.indexOf(quote, pathStart);
  const exports = await import(new URL(source.slice(pathStart, pathEnd), entry).href);
  const store = Object.values(exports).find(value => typeof value === 'function' && 'LastCreatedScene' in value);
  const deadline = performance.now() + 30000;
  while (!store.LastCreatedScene?.metadata?.staticShadows) {
    if (performance.now() > deadline) throw new Error('X-Ray scene did not become ready');
    await new Promise(requestAnimationFrame);
  }
  scene = store.LastCreatedScene;
  }
  const engine = scene.getEngine();
  const shadow = scene.metadata.staticShadows;
  const errors = [];
  const onError = event => errors.push(event.error.message);
  engine._device.addEventListener('uncapturederror', onError);
  const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
  const wireMeshes = () => scene.meshes.filter(mesh => mesh.name.endsWith('-wire'));
  const collectTargets = () => {
    const equipmentRoot = scene.getTransformNodeByName('procedural-equipment');
    const subfabRoot = scene.getTransformNodeByName('procedural-subfab');
    const ohtRoot = scene.getTransformNodeByName('native-amhs');
    const roles = { equipment: [], subfab: [], oht: [], floor: [], line: [] };
    if (equipmentRoot) roles.equipment = equipmentRoot.getChildMeshes().filter(mesh => !mesh.name.endsWith('-wire')).map(mesh => mesh.uniqueId);
    if (subfabRoot) roles.subfab = subfabRoot.getChildMeshes().map(mesh => mesh.uniqueId);
    const dense = scene.meshes.filter(mesh => mesh.material && String(mesh.material.name).startsWith('subfab-')).map(mesh => mesh.uniqueId);
    roles.subfab = [...new Set([...roles.subfab, ...dense])];
    if (ohtRoot) roles.oht = ohtRoot.getChildMeshes().filter(mesh => !mesh.name.includes('-shadow')).map(mesh => mesh.uniqueId);
    roles.floor = scene.meshes.filter(mesh => mesh.material?.name === 'procedural-floor-material').map(mesh => mesh.uniqueId);
    roles.line = wireMeshes().map(mesh => mesh.uniqueId);
    return roles;
  };
  const readPixels = () => {
    sampleCanvas.width = canvas.width; sampleCanvas.height = canvas.height;
    sampleContext.drawImage(canvas, 0, 0);
    return sampleContext.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  window.__fabXrayAcceptance = {
    scene, engine, shadow, errors, frames, collectTargets,
    dispose() { engine._device.removeEventListener('uncapturederror', onError); },
    shadowInfo() {
      return { texture: shadow.texture?.uniqueId ?? null, enabled: shadow.enabled, ready: shadow.readyForCurrentDevice,
        matrix: shadow.matrix ? shadow.matrix.asArray() : null, stats: shadow.stats };
    },
    materialState(ids) {
      const set = new Set(ids);
      return scene.meshes.filter(mesh => set.has(mesh.uniqueId)).map(mesh => ({
        uniqueId: mesh.uniqueId, name: mesh.name, material: mesh.material?.name ?? null,
        materialUniqueId: mesh.material?.uniqueId ?? -1, className: mesh.material?.getClassName() ?? null,
        xrayCaster: mesh.metadata?.xrayCaster === true,
      }));
    },
    originalState(roles) {
      const all = [...roles.equipment, ...roles.subfab, ...roles.oht, ...roles.floor, ...roles.line];
      const states = window.__fabXrayAcceptance.materialState(all);
      window.__fabXrayOriginals = states;
      return states;
    },
    shaderProbe(roles) {
      const all = [...roles.equipment, ...roles.subfab, ...roles.oht, ...roles.floor];
      const set = new Set(all);
      const wireSet = new Set(roles.line);
      const triangle = scene.meshes.find(mesh => set.has(mesh.uniqueId) && mesh.material?.name?.startsWith('fab-xray-'));
      const line = scene.meshes.find(mesh => wireSet.has(mesh.uniqueId));
      const describe = mesh => {
        const material = mesh.material;
        const info = window.__fabXrayAcceptance.shadowInfo();
        return {
          mesh: mesh.name, material: material.name, className: material.getClassName(),
          shadowTexture: material._textures?.xrayShadowDepth?.uniqueId ?? null,
          shadowEnabled: material._floats?.xrayShadowEnabled ?? null,
          lightVP: material._matrices?.xrayLightVP ? material._matrices.xrayLightVP.asArray() : null,
          expectedTexture: info.texture, expectedMatrix: info.matrix,
        };
      };
      return { triangle: triangle ? describe(triangle) : null, line: line ? describe(line) : null };
    },
  };
})()`;

export async function runXrayAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Browser condition timed out: ' + expression);
  }
  const clickXray = () => evaluate("document.querySelector('#btn-toggle-xray').click()");
  const clickFilter = label => evaluate("document.getElementById('xray-btn-' + " + JSON.stringify(label.toLowerCase()) + ")?.click()");

  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  await until("!!document.querySelector('.twin-page')");
  await evaluate("localStorage.setItem('semicon_twin_onboarding_dismissed','1')");
  await command('Page.reload', { ignoreCache: false });
  await until("!!document.querySelector('.twin-page')");
  await until("document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')", 60000);
  // Material identity checks require a stable SEMI E10 state. Demo ticks otherwise
  // legitimately replace status-LED materials while the shader test is running.
  await evaluate("if (document.querySelector('#btn-sim-play')?.getAttribute('aria-pressed') === 'true') document.querySelector('#btn-sim-play').click()");
  await evaluate(PAGE_SETUP);
  await evaluate('__fabXrayAcceptance.frames(10)');
  const initialShadow = await evaluate('__fabXrayAcceptance.shadowInfo()');
  const roles = await evaluate('__fabXrayAcceptance.collectTargets()');
  const originals = await evaluate('__fabXrayAcceptance.originalState(' + JSON.stringify(roles) + ')');
  const ROOT_STATE = "(() => { const scene = __fabXrayAcceptance.scene; const names = ['procedural-equipment', 'procedural-subfab', 'native-amhs']; const state = Object.fromEntries(names.map(name => [name, scene.getTransformNodeByName(name)?.isEnabled() ?? null])); const floor = scene.meshes.find(mesh => mesh.material?.name === 'procedural-floor-material'); state.floor = floor?.isEnabled() ?? null; return state; })()";
  const rootsInitial = await evaluate(ROOT_STATE);
  assert.ok(roles.equipment.length > 100, 'equipment X-Ray targets expected');
  assert.ok(roles.subfab.length > 100, 'subfab X-Ray targets expected');
  assert.ok(roles.oht.length > 50, 'OHT X-Ray targets expected');
  assert.ok(roles.line.length > 0, 'catalog wire targets expected');
  await evaluate('__fabXrayAcceptance.frames(4)');

  await clickXray();
  await until("document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'true'");
  await evaluate('__fabXrayAcceptance.frames(10)');

  const assigned = await evaluate('__fabXrayAcceptance.materialState(' + JSON.stringify([...roles.equipment, ...roles.subfab, ...roles.oht, ...roles.floor]) + ')');
  assert.equal(assigned.every(mesh => mesh.className === 'ShaderMaterial'), true, 'every X-Ray surface must use the single ShaderMaterial program');
  assert.equal(assigned.every(mesh => String(mesh.material).startsWith('fab-xray-')), true);
  const wired = await evaluate('__fabXrayAcceptance.materialState(' + JSON.stringify(roles.line) + ')');
  assert.equal(wired.length, roles.line.length);
  assert.equal(wired.every(mesh => mesh.material === 'fab-xray-line'), true, 'catalog wires must use the same shader program');
  const distinct = await evaluate('__fabXrayAcceptance.materialState(' + JSON.stringify([...roles.equipment, ...roles.subfab, ...roles.oht, ...roles.floor]) + ').map(mesh => mesh.material)');
  assert.ok(new Set(distinct).size <= 6, 'shader material instances must only vary uniforms, not programs');

  const probe = await evaluate('__fabXrayAcceptance.shaderProbe(' + JSON.stringify(roles) + ')');
  for (const surface of [probe.triangle, probe.line]) {
    assert.ok(surface, 'X-Ray shader surface expected');
    assert.equal(surface.className, 'ShaderMaterial');
    assert.equal(surface.shadowTexture, surface.expectedTexture, 'native shadow depth must be bound into the hologram shader');
    assert.equal(surface.shadowEnabled, 1, 'hologram shadow sampling must be enabled');
    assert.deepEqual(surface.lightVP, surface.expectedMatrix, 'hologram light matrix must equal the native shadow matrix');
  }

  const capture = async () => {
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    return decodePng(Buffer.from(shot.data, 'base64'));
  };
  // Freeze the moving OHT layer for the pixel comparison; the hologram surfaces and shadow map remain.
  await evaluate("document.querySelector('#btn-toggle-oht').click(); __fabXrayAcceptance.frames(6)");
  const controlA = await capture();
  await evaluate('__fabXrayAcceptance.frames(2)');
  const controlB = await capture();
  const baselineDiff = imageDiff(controlA, controlB);
  await evaluate('__fabXrayAcceptance.shadow.enabled = false; __fabXrayAcceptance.frames(3)');
  const shadowOffShot = await capture();
  await evaluate('__fabXrayAcceptance.shadow.enabled = true; __fabXrayAcceptance.frames(3)');
  const shadowOnShot = await capture();
  const shadowOffDiff = imageDiff(shadowOffShot, shadowOnShot);
  await evaluate("document.querySelector('#btn-toggle-oht').click(); __fabXrayAcceptance.frames(4)");
  assert.equal(await evaluate('__fabXrayAcceptance.shadowInfo().enabled'), true);
  assert.ok(shadowOffDiff.mean > 0.05 && shadowOffDiff.mean > baselineDiff.mean * 1.5, 'native shadow depth must change rendered X-Ray frames: ' + JSON.stringify({ shadowOffDiff, baselineDiff }));

  const filters = [];
  for (const label of ['All', 'UPW', 'Gas', 'Vac', 'Exhaust', 'AMHS']) {
    await clickFilter(label);
    await evaluate('__fabXrayAcceptance.frames(4)');
    filters.push(await evaluate("[...document.querySelectorAll('.twin-xray button')].filter(button => button.className.includes('active')).map(button => button.id.replace('xray-btn-',''))"));
  }
  assert.deepEqual(filters.map(active => active[0]), ['all', 'upw', 'gas', 'vac', 'exhaust', 'amhs']);

  await clickXray();
  await until("document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'false'");
  await evaluate('__fabXrayAcceptance.frames(10)');
  const restored = await evaluate('__fabXrayAcceptance.materialState(' + JSON.stringify([...roles.equipment, ...roles.subfab, ...roles.oht, ...roles.floor, ...roles.line]) + ')');
  assert.equal(restored.length, originals.length);
  for (const before of originals) {
    const after = restored.find(mesh => mesh.uniqueId === before.uniqueId);
    assert.ok(after, 'restored mesh missing: ' + before.name);
    assert.equal(after.materialUniqueId, before.materialUniqueId, 'material reference not restored: ' + before.name);
    assert.equal(after.material, before.material);
    assert.equal(after.xrayCaster, false, 'X-Ray caster flag not cleared: ' + before.name);
  }
  const rootsRestored = await evaluate(ROOT_STATE);
  assert.deepEqual(rootsRestored, rootsInitial, 'scene visibility must return to its pre-X-Ray state');
  const finalShadow = await evaluate('__fabXrayAcceptance.shadowInfo()');
  assert.equal(finalShadow.stats.casterCount, initialShadow.stats.casterCount, 'shadow caster set must return to its baseline');
  await evaluate('__fabXrayAcceptance.scene.activeCamera.alpha += 0.12; __fabXrayAcceptance.frames(8)');
  assert.equal(await evaluate('__fabXrayAcceptance.shadowInfo().stats.passes'), finalShadow.stats.passes, 'shadow cache must stay cached after X-Ray restore');
  assert.equal(await evaluate('__fabXrayAcceptance.errors.length'), 0);
  const result = {
    roles: Object.fromEntries(Object.entries(roles).map(([role, ids]) => [role, ids.length])),
    distinctMaterials: new Set(distinct).size,
    shadow: { initial: initialShadow.stats, final: finalShadow.stats },
    shadowOffDiff,
    baselineDiff,
    filters: filters.map(active => active[0]),
    restoredMeshes: restored.length,
    rootsInitial,
    rootsRestored,
  };
  await evaluate('__fabXrayAcceptance.dispose()');
  return result;
}
