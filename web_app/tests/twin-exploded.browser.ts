// @ts-nocheck — executable CDP acceptance, using a supplied browser transport.
import assert from 'node:assert/strict';
import { PERSONNEL } from '../src/personnel-timeline.ts';

const PAGE_SETUP = `(async () => {\n  const perf = window.__SEMICONFAB_PERF__;\n  let scene;\n  let engine;\n  let shadow;\n  if (perf?.getScene) {\n    const deadline = performance.now() + 30000;\n    while (!perf.getShadow()?.readyForCurrentDevice) {\n      if (performance.now() > deadline) throw new Error('repair scene did not become ready');\n      await new Promise(requestAnimationFrame);\n    }\n    scene = perf.getScene();\n    engine = perf.getEngine();\n    shadow = perf.getShadow();\n  } else {\n    const quote = String.fromCharCode(34);\n    const entry = performance.getEntriesByType('resource').findLast(r => r.name.includes('/@babylonjs_core_Engines_webgpuEngine.js')).name;\n    const source = await (await fetch(entry)).text();\n    const markerAt = source.indexOf(' as EngineStore');\n    const fromAt = source.indexOf('from ' + quote, markerAt);\n    const pathStart = fromAt + 6;\n    const pathEnd = source.indexOf(quote, pathStart);\n    const exports = await import(new URL(source.slice(pathStart, pathEnd), entry).href);\n    const store = Object.values(exports).find(value => typeof value === 'function' && 'LastCreatedScene' in value);\n    const deadline = performance.now() + 30000;\n    while (!store.LastCreatedScene?.metadata?.staticShadows) {\n      if (performance.now() > deadline) throw new Error('repair scene did not become ready');\n      await new Promise(requestAnimationFrame);\n    }\n    scene = store.LastCreatedScene;\n    engine = scene.getEngine();\n    shadow = scene.metadata.staticShadows;\n  }
  const errors = [];
  const onError = event => errors.push(event.error.message);
  engine._device.addEventListener('uncapturederror', onError);
  const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
  const node = name => scene.getTransformNodeByName(name);
  const state = () => {
    const camera = scene.activeCamera;
    const floorMesh = scene.meshes.find(mesh => mesh.name === 'procedural-floor');
    const floorMaterial = floorMesh?.material;
    const links = node('original-exploded-interconnects');
    const tubes = links ? links.getChildMeshes().filter(mesh => mesh.name.startsWith('original-interconnect-') && !mesh.name.includes('-ring-')) : [];
    const ring = tubes[0]?.getChildMeshes().find(mesh => mesh.name.includes('-ring-')) ?? null;
    const tools = new Set(scene.meshes.filter(mesh => Number.isInteger(mesh.metadata?.toolIndex)).map(mesh => mesh.metadata.toolIndex));
    const operators = [0, 1, 2, 3, 4, 5].map(index => {
      const group = node('operator-' + index);
      return group ? { x: group.position.x, y: group.position.y, z: group.position.z, rotY: group.rotation.y } : null;
    });
    return {
      camera: camera ? { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: { x: camera.target.x, y: camera.target.y, z: camera.target.z } } : null,
      nodes: {
        ceilingY: node('ceilingFFU')?.position.y ?? null,
        ceilingEnabled: node('ceilingFFU')?.isEnabled() ?? null,
        subfabY: node('procedural-subfab')?.position.y ?? null,
        denseY: node('subfabDenseIndustrialFacilities')?.position.y ?? null,
        equipmentY: node('procedural-equipment')?.position.y ?? null,
      },
      floor: floorMaterial ? { name: floorMaterial.name, alpha: floorMaterial.alpha, transparencyMode: floorMaterial.transparencyMode, enabled: floorMesh.isEnabled() } : null,
      links: { enabled: links?.isEnabled() ?? null, tubes: tubes.length, firstScaleY: tubes[0]?.scaling.y ?? null, firstY: tubes[0]?.position.y ?? null, ringY: ring?.position.y ?? null },
      toolCount: tools.size,
      operators,
      billboard: !!scene.getMeshByName('original-patrol-status'),
      billboardVisible: scene.getMeshByName('original-patrol-status')?.isEnabled() ?? false,
      airShowerMeshes: node('airShowerChambers')?.getChildMeshes().length ?? 0,
      shadow: shadow.stats,
      deviceErrors: errors.length,
    };
  };
  window.__repairAcceptance = { scene, engine, shadow, errors, frames, state, dispose() { engine._device.removeEventListener('uncapturederror', onError); } };
})()`;

export async function runTwinExplodedAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
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
  const state = () => evaluate('__repairAcceptance.state()');
  const frames = n => evaluate('__repairAcceptance.frames(' + n + ')');
  const clickLevel = index => evaluate("document.querySelectorAll('.twin-levels button')[" + index + "].click()");
  const setSlider = percent => evaluate("(() => { const slider = document.querySelector('.twin-explode input[type=range]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(slider, '" + percent + "'); slider.dispatchEvent(new Event('input', { bubbles: true })); })()");

  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  await until("!!document.querySelector('.twin-page')");
  await evaluate("localStorage.setItem('semicon_twin_onboarding_dismissed','1')");
  await command('Page.reload', { ignoreCache: false });
  await until("!!document.querySelector('.twin-page')");
  await until("document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')", 60000);
  await command('Runtime.discardConsoleEntries').catch(() => undefined);
  await command('Log.clear').catch(() => undefined);
  await evaluate(PAGE_SETUP);
  await frames(12);

  const initial = await state();
  assert.equal(initial.toolCount, 121, 'exploded links must not change the 121 tool identities');
  assert.equal(initial.links.enabled, false);
  assert.equal(initial.links.tubes, 12, '12 source-defined L1/B1 interconnects');
  assert.equal(initial.nodes.ceilingY, 0);
  assert.equal(initial.nodes.subfabY, 0);
  assert.equal(initial.nodes.equipmentY, 0);
  assert.equal(initial.nodes.ceilingEnabled, false);
  assert.equal(initial.floor.alpha, 1);
  assert.equal(initial.floor.transparencyMode, 0);
  for (let index = 0; index < PERSONNEL.length - 1; index += 1) {
    assert.ok(Math.abs(initial.operators[index].x - PERSONNEL[index].x) < 0.01, 'source operator x ' + index);
    assert.ok(Math.abs(initial.operators[index].z - PERSONNEL[index].z) < 0.01, 'source operator z ' + index);
    assert.ok(Math.abs(initial.operators[index].rotY - PERSONNEL[index].rotY) < 0.01, 'source operator rotation ' + index);
  }
  assert.equal(initial.billboard, true);
  assert.ok(initial.airShowerMeshes > 50);

  await clickLevel(3);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === true && Math.abs(s.nodes.ceilingY - 20) < 0.001 && Math.abs(s.nodes.subfabY + 18) < 0.001; })()", 30000);
  await frames(6);
  const exploded = await state();
  assert.equal(exploded.toolCount, 121);
  assert.equal(exploded.links.enabled, true);
  assert.equal(exploded.links.tubes, 12);
  assert.ok(Math.abs(exploded.links.firstScaleY - 25 / 7) < 0.01, 'conduit follows source scaling');
  assert.ok(Math.abs(exploded.links.firstY + 12.5) < 0.05, 'conduit follows source midpoint');
  assert.ok(Math.abs(exploded.links.ringY) <= 3.09, 'pulse ring stays inside the source sinusoid');
  assert.ok(Math.abs(exploded.nodes.ceilingY - 20) < 0.001);
  assert.ok(Math.abs(exploded.nodes.subfabY + 18) < 0.001);
  assert.ok(Math.abs(exploded.nodes.denseY + 18) < 0.001);
  assert.equal(exploded.nodes.equipmentY, 0, 'source exploded view moves ceiling/subfab, not the equipment');
  assert.equal(exploded.nodes.ceilingEnabled, true);
  assert.ok(Math.abs(exploded.floor.alpha - 0.55) < 0.001);
  assert.equal(exploded.floor.transparencyMode, 2);
  assert.ok(Math.abs(exploded.camera.target.y + 4) < 0.05, 'source entry pose target');
  assert.ok(exploded.camera.radius > 98 && exploded.camera.radius < 108, 'source entry pose distance');
  assert.ok(exploded.shadow.casterCount > initial.shadow.casterCount, 'exploded mode shows the subfab layer as casters');
  await frames(6);
  const settledPasses = (await state()).shadow.passes;
  await frames(30);
  assert.equal((await state()).shadow.passes, settledPasses, 'shadow cache must settle after exploded easing');

  await setSlider(0);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === false && Math.abs(s.nodes.ceilingY) < 0.001 && Math.abs(s.nodes.subfabY) < 0.001; })()", 30000);
  await frames(4);
  const stacked = await state();
  assert.equal(stacked.links.enabled, false);
  assert.equal(stacked.toolCount, 121);
  assert.ok(Math.abs(stacked.floor.alpha - 0.55) < 0.001, '0% still keeps the exploded mode active');
  assert.ok(Math.abs(stacked.camera.target.y + 4) < 0.05, '0% slider must keep the source entry camera');
  assert.equal(await evaluate("[...document.querySelectorAll('.twin-levels button')][3].className.includes('active')"), true);

  await setSlider(50);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === true && Math.abs(s.nodes.ceilingY - 10) < 0.002 && Math.abs(s.nodes.subfabY + 9) < 0.002; })()", 30000);
  await frames(4);
  const half = await state();
  assert.ok(Math.abs(half.links.firstScaleY - 16 / 7) < 0.01);

  // Switching to B1 closes the exploded mode and applies the source B1 floor opacity/pose.
  await clickLevel(1);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === false && Math.abs(s.nodes.subfabY) < 0.001 && Math.abs(s.floor.alpha - 0.2) < 0.001 && Math.abs(s.camera.target.y + 6) < 0.05; })()", 30000);
  await frames(4);
  const b1 = await state();
  assert.equal(b1.floor.transparencyMode, 2);
  assert.equal(b1.toolCount, 121);
  assert.equal(b1.nodes.ceilingEnabled, false);

  // Dual level keeps its own source floor opacity and camera pose.
  await clickLevel(2);
  await until("(() => { const s = __repairAcceptance.state(); return Math.abs(s.floor.alpha - 0.35) < 0.001 && Math.abs(s.camera.target.y + 3) < 0.05; })()", 30000);
  await frames(4);
  const dual = await state();
  assert.equal(dual.floor.transparencyMode, 2);
  assert.equal(dual.toolCount, 121);

  await clickLevel(0);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === false && Math.abs(s.nodes.subfabY) < 0.001 && Math.abs(s.nodes.ceilingY) < 0.001 && Math.abs(s.floor.alpha - 1) < 0.001; })()", 30000);
  await frames(4);
  const restored = await state();
  assert.equal(restored.links.enabled, false);
  assert.equal(restored.nodes.ceilingEnabled, false);
  assert.equal(restored.floor.alpha, 1);
  assert.equal(restored.floor.transparencyMode, 0);
  assert.equal(restored.toolCount, 121);
  assert.ok(Math.abs(restored.camera.target.y - 2) < 0.05, 'source exit default pose target');
  assert.ok(restored.camera.radius > 76 && restored.camera.radius < 86, 'source exit pose distance');

  // Patrol actor follows the single source timeline; the as-built billboard stays visible.
  const patrolA = (await state()).operators[5];
  await new Promise(resolve => setTimeout(resolve, 1200));
  const patrolB = (await state()).operators[5];
  assert.ok(Math.hypot(patrolB.x - patrolA.x, patrolB.z - patrolA.z) > 0.05, 'patrol actor must move with the source timeline');

  // X-Ray remains compatible while exploded; restore leaves the exploded floor state intact.
  await clickLevel(3);
  await until("(() => { const s = __repairAcceptance.state(); return Math.abs(s.nodes.ceilingY - 20) < 0.001; })()", 30000);
  await frames(4);
  await evaluate("document.querySelector('#btn-toggle-xray').click()");
  await until("document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'true'");
  await frames(12);
  const xray = await evaluate("({ shaderMeshes: __repairAcceptance.scene.meshes.filter(mesh => String(mesh.material?.name).startsWith('fab-xray-')).length, floor: __repairAcceptance.state().floor })");
  assert.ok(xray.shaderMeshes > 2000);
  assert.equal(xray.floor.name.startsWith('fab-xray-'), true);
  await evaluate("document.querySelector('#btn-toggle-xray').click()");
  await until("document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'false'");
  await frames(10);
  const afterXray = await state();
  assert.equal(afterXray.floor.name, 'procedural-floor-material');
  assert.ok(Math.abs(afterXray.floor.alpha - 0.55) < 0.001, 'X-Ray restore keeps the exploded floor opacity');

  // Language switch keeps the visible original billboard and does not stop the timeline.
  await evaluate("document.querySelector('#lang-toggle-btn').click()");
  await until("document.documentElement.lang === 'en-US'");
  await frames(10);
  assert.equal((await state()).billboard, true);
  await evaluate("document.querySelector('#lang-toggle-btn').click()");
  await until("document.documentElement.lang === 'zh-CN'");
  await clickLevel(0);
  await until("(() => { const s = __repairAcceptance.state(); return s.links.enabled === false && Math.abs(s.nodes.subfabY) < 0.001; })()", 30000);
  await frames(4);
  const final = await state();
  assert.equal(final.deviceErrors, 0, 'GPU device errors');
  await evaluate('__repairAcceptance.dispose()');
  return {
    initial: { toolCount: initial.toolCount, casterCount: initial.shadow.casterCount, floorAlpha: initial.floor.alpha },
    exploded: { ceilingY: exploded.nodes.ceilingY, subfabY: exploded.nodes.subfabY, cameraTargetY: exploded.camera.target.y, links: exploded.links.tubes, casterCount: exploded.shadow.casterCount, shadowPasses: settledPasses },
    stacked: { linksEnabled: stacked.links.enabled, cameraTargetY: stacked.camera.target.y, floorAlpha: stacked.floor.alpha },
    half: { ceilingY: half.nodes.ceilingY, subfabY: half.nodes.subfabY, scaleY: half.links.firstScaleY },
    levels: { b1FloorAlpha: b1.floor.alpha, b1CameraTargetY: b1.camera.target.y, dualFloorAlpha: dual.floor.alpha, dualCameraTargetY: dual.camera.target.y },
    restored: { cameraTargetY: restored.camera.target.y, floorAlpha: restored.floor.alpha, casterCount: restored.shadow.casterCount, toolCount: restored.toolCount },
    patrolMovedMeters: Math.hypot(patrolB.x - patrolA.x, patrolB.z - patrolA.z),
    xray: { shaderMeshes: xray.shaderMeshes, floorRestored: afterXray.floor.name, explodedFloorAlpha: afterXray.floor.alpha },
    final: { toolCount: final.toolCount, deviceErrors: final.deviceErrors },
  };
}
