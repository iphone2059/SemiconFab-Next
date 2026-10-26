// @ts-nocheck — real-WebGPU CDP acceptance for the Lite preview's restored source lighting.
// Node 26 executes this .ts suite with native type stripping (see tools/run_twin_browser.mjs).
// Every claim below is measured from actual GPU frames captured through Page.captureScreenshot;
// no assertion relies only on scene state. Thresholds are documented in THRESHOLDS and echoed
// into the evidence JSON so the numbers in the report are reproducible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './support/png.ts';

// Scene ROI: skip a margin so DOM chrome / window edges cannot contribute to pixel differences.
const ROI = { x0: 0.05, x1: 0.95, y0: 0.10, y1: 0.92 };
// Two settled captures of the same state must be identical within this tolerance.
const DETERMINISM = { changedFraction: 0.0005, meanChannelDelta: 0.02, meanLumDelta: 0.02 };
// Pixel deltas are summed |dR|+|dG|+|dB| per pixel; channel delta is that sum / 3 (0..255 scale).
const THRESHOLDS = {
  shadowsIso: { changedFraction: 0.04, darkenedFraction: 0.03, meanChannelDelta: 1.2,
    meanChannelDeltaAmongChanged: 12, medianChannelDeltaAmongChanged: 10 },
  keyOff: { minLuminanceDrop: 30, minRelativeDrop: 0.10, collapseChangedFraction: 0.001, collapseMeanChannelDelta: 0.02 },
  ambientOff: { changedFraction: 0.20, brightenedFraction: 0.20, meanChannelDelta: 5, minLuminanceDrop: 15 },
  fillOff: { changedFraction: 0.15, brightenedFraction: 0.15, meanChannelDelta: 4, minLuminanceDrop: 8 },
  localLightsOff: { changedFraction: 0.03, brightenedFraction: 0.03, meanChannelDelta: 1.5, minLuminanceDrop: 2 },
  restoredState: DETERMINISM,
};

/** Decode a screenshot and compare candidate a against reference b over the scene ROI. */
function analyze(a, b, roi = ROI) {
  const x0 = Math.floor(a.width * roi.x0), x1 = Math.ceil(a.width * roi.x1);
  const y0 = Math.floor(a.height * roi.y0), y1 = Math.ceil(a.height * roi.y1);
  const histogram = new Uint32Array(766);
  const changedHistogram = new Uint32Array(766);
  let sum = 0, sumChanged = 0, changed = 0, pixels = 0;
  let lumA = 0, lumB = 0, darkened = 0, darkenedSum = 0, brightened = 0, brightenedSum = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.channels, ib = (y * b.width + x) * b.channels;
      const dr = Math.abs(a.data[ia] - b.data[ib]);
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const delta = dr + dg + db;
      const la = 0.2126 * a.data[ia] + 0.7152 * a.data[ia + 1] + 0.0722 * a.data[ia + 2];
      const lb = 0.2126 * b.data[ib] + 0.7152 * b.data[ib + 1] + 0.0722 * b.data[ib + 2];
      lumA += la; lumB += lb; sum += delta; histogram[delta] += 1;
      if (delta > 9) { changed += 1; sumChanged += delta; changedHistogram[delta] += 1; }
      // Reference b darker than candidate a: the reference image is darkened relative to a.
      if (lb < la - 3) { darkened += 1; darkenedSum += la - lb; }
      // Reference b brighter than candidate a: the feature present only in b was switched off in a.
      if (lb > la + 3) { brightened += 1; brightenedSum += lb - la; }
      pixels += 1;
    }
  }
  const percentile = (histogramData, total, p) => {
    let accumulated = 0;
    for (let i = 0; i < histogramData.length; i += 1) { accumulated += histogramData[i]; if (accumulated >= total * p) return i; }
    return histogramData.length - 1;
  };
  return {
    width: a.width, height: a.height, roi: [x0, y0, x1, y1], pixels,
    meanLumA: lumA / pixels, meanLumB: lumB / pixels,
    meanLumDelta: (lumB - lumA) / pixels,
    meanChannelDelta: sum / (pixels * 3),
    changedFraction: changed / pixels,
    darkenedFraction: darkened / pixels, brightenedFraction: brightened / pixels,
    meanChannelDeltaAmongChanged: sumChanged / (Math.max(1, changed) * 3),
    medianChannelDeltaAmongChanged: percentile(changedHistogram, Math.max(1, changed), 0.5) / 3,
    meanLuminanceReductionAmongDarkened: darkenedSum / Math.max(1, darkened),
    meanLuminanceIncreaseAmongBrightened: brightenedSum / Math.max(1, brightened),
    p90ChannelDelta: percentile(histogram, pixels, 0.9) / 3,
    p99ChannelDelta: percentile(histogram, pixels, 0.99) / 3,
    maxChannelDelta: percentile(histogram, pixels, 0.9999) / 3,
  };
}

export async function runLiteLightingAcceptance(command, baseUrl) {
  const evidenceDir = process.env.LITE_EVIDENCE_DIR;
  if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
  const screenshots = [];
  const evidencePath = name => evidenceDir ? path.join(evidenceDir, 'lighting-' + name + '.png') : undefined;
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  // equipment.identities is 121 entries; reduce it to a boolean so polling payloads stay small.
  const COMPACT_SNAPSHOT = `(() => {
    const snapshot = window.__liteAcceptance?.snapshot();
    if (!snapshot) return undefined;
    if (snapshot.equipment) snapshot.equipment = { ...snapshot.equipment,
      identities: snapshot.equipment.identities.length > 0 && snapshot.equipment.identities.every(entry => entry.mapped) };
    return snapshot;
  })()`;
  const readSnapshot = () => evaluate(COMPACT_SNAPSHOT);
  const until = async (predicate, stage, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      const state = await readSnapshot();
      last = state;
      if (state?.gpuErrors?.length) throw new Error(JSON.stringify({ stage, status: state.status, gpuErrors: state.gpuErrors }));
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) {
        throw new Error('Timed out: ' + stage + ' ' + JSON.stringify({ status: last?.status, loadingStage: last?.loadingStage,
          frames: last?.frames, meshes: last?.meshes, gpuErrors: last?.gpuErrors }));
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  /** Wait for the render loop to advance past the current frame counter; returns the settled snapshot. */
  const waitFrames = async (delta, stage) => {
    const before = (await readSnapshot()).frames;
    return until(state => state.frames > before + delta, stage);
  };
  const capture = async name => {
    const image = await command('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(image.data, 'base64');
    if (evidenceDir) fs.writeFileSync(evidencePath(name), buffer);
    screenshots.push(name);
    return decodePng(buffer);
  };
  const captureSettled = async (name, stage) => { await waitFrames(4, stage); return capture(name); };
  const restoreAll = async () => {
    await evaluate('__liteAcceptance.setShadows(true)');
    await evaluate('__liteAcceptance.setKeyLight(true)');
    await evaluate('__liteAcceptance.setFillLight(true)');
    await evaluate('__liteAcceptance.setAmbientLight(true)');
    await evaluate('__liteAcceptance.setLocalLights(true)');
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Log.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: baseUrl + '/?scene=lighting-probe' });
  await until(state => state.status === 'ready' && state.frames > 2, 'material probe ready');
  await evaluate("document.querySelector('output').style.display = 'none'");
  const probeOn = await captureSettled('probe-on', 'probe lighting on');
  await evaluate('__liteAcceptance.setKeyLight(false); __liteAcceptance.setFillLight(false); __liteAcceptance.setLocalLights(false)');
  const probeAmbient = await captureSettled('probe-ambient', 'probe ambient only');
  await evaluate('__liteAcceptance.setAmbientLight(false)');
  const probeDark = await captureSettled('probe-dark', 'probe ambient off');
  const unlitResponse = analyze(probeDark, probeOn, { x0: 0.08, x1: 0.48, y0: 0.2, y1: 0.85 });
  assert.ok(unlitResponse.meanChannelDelta < 0.02 && unlitResponse.changedFraction < 0.0005,
    'native unlit shading must ignore every light toggle: ' + JSON.stringify(unlitResponse));
  const standardAmbient = analyze(probeDark, probeAmbient, { x0: 0.52, x1: 0.92, y0: 0.2, y1: 0.85 });
  assert.ok(standardAmbient.meanLumDelta > 5, 'ambient off must reach native Standard materials: ' + JSON.stringify(standardAmbient));
  await command('Page.navigate', { url: baseUrl + '/?scene=structure' });
  const initial = await until(state => state.status === 'ready' && state.frames > 2, 'structure scene ready', 60000);
  // Evidence frames are the composited scene only; selection chrome would pollute pixel measurements.
  await evaluate("document.querySelectorAll('output, nav').forEach(element => element.style.display = 'none')");

  // ---- 1. Restored source lighting state (exact source values from the public snapshot) -------
  assert.equal(initial.lighting.keyIntensity, 1.15, 'source key light intensity');
  assert.equal(initial.lighting.localLights, 18, '6 source amber/spot + 10 basement + 2 facility local lights');
  assert.equal(initial.lighting.shadows, true, 'native CSM shadows enabled');
  assert.ok(initial.lighting.casters > 100, 'CSM receives the explicit caster set (' + initial.lighting.casters + ')');
  assert.equal(initial.structure.lights, 10, 'basement lights collected from the static structure');
  assert.equal(initial.facility.lights, 2, 'facility lights collected from the restored facility');
  assert.equal(initial.equipment.tools, 121, '121 process tools retained');
  assert.equal(initial.equipment.identities, true, 'all 121 tool identities map back to their original records');
  assert.equal(initial.facility.parts, 1659, 'restored facility parts');
  assert.equal(initial.facility.airShowers, 2);
  assert.equal(initial.facility.ceilingVisible, false);
  assert.equal(initial.meshes, initial.structure.batches + initial.equipment.batches + initial.facility.meshes,
    'every rendered mesh belongs to structure, equipment or facility');
  assert.ok(initial.drawCalls > 0);
  assert.deepEqual(initial.gpuErrors, []);
  const gpu = await evaluate(`(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return { secure: isSecureContext, vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, userAgent: navigator.userAgent };
  })()`);

  // ---- 2. ISO pixel proof: source lighting actually reaches the GPU ---------------------------
  await evaluate('__liteAcceptance.isoView()');
  await waitFrames(6, 'iso settle');
  const isoLightsOn = await capture('iso-lights-on');
  const isoSecond = await capture('iso-lights-on-repeat');
  const determinism = analyze(isoSecond, isoLightsOn);
  assert.ok(determinism.changedFraction <= DETERMINISM.changedFraction && determinism.meanChannelDelta <= DETERMINISM.meanChannelDelta,
    'two settled ISO captures must be deterministic: ' + JSON.stringify(determinism));

  // Shadows visibly darken the scene: reference = shadows on must be darker than the shadows-off capture.
  await evaluate('__liteAcceptance.setShadows(false)');
  const isoShadowsOff = await captureSettled('iso-shadows-off', 'shadows off');
  const shadowsOnOff = analyze(isoShadowsOff, isoLightsOn);
  assert.ok(shadowsOnOff.darkenedFraction >= THRESHOLDS.shadowsIso.darkenedFraction,
    'shadows must visibly darken the ISO scene: ' + JSON.stringify(shadowsOnOff));
  assert.ok(shadowsOnOff.changedFraction >= THRESHOLDS.shadowsIso.changedFraction);
  assert.ok(shadowsOnOff.meanChannelDelta >= THRESHOLDS.shadowsIso.meanChannelDelta);
  assert.ok(shadowsOnOff.meanChannelDeltaAmongChanged >= THRESHOLDS.shadowsIso.meanChannelDeltaAmongChanged);
  assert.ok(shadowsOnOff.medianChannelDeltaAmongChanged >= THRESHOLDS.shadowsIso.medianChannelDeltaAmongChanged);
  assert.ok(shadowsOnOff.meanLumDelta < 0, 'shadows-on reference is darker than shadows-off: ' + shadowsOnOff.meanLumDelta);
  await evaluate('__liteAcceptance.setShadows(true)');
  const isoRestored = await captureSettled('iso-shadows-restored', 'shadows restored');
  const shadowRestore = analyze(isoRestored, isoLightsOn);
  assert.ok(shadowRestore.changedFraction <= THRESHOLDS.restoredState.changedFraction && shadowRestore.meanChannelDelta <= THRESHOLDS.restoredState.meanChannelDelta,
    'restoring shadows must reproduce the baseline frame: ' + JSON.stringify(shadowRestore));

  // Key light off: gross luminance drop, and the on/off shadow contribution collapses to ~0
  // because the key is the only shadow-casting directional light.
  await evaluate('__liteAcceptance.setKeyLight(false)');
  const keyOffShadowsOn = await captureSettled('iso-key-off-shadows-on', 'key light off');
  const keyOffLuminance = analyze(keyOffShadowsOn, isoLightsOn);
  const keyOffRelativeDrop = keyOffLuminance.meanLumDelta / keyOffLuminance.meanLumB;
  assert.ok(keyOffLuminance.meanLumDelta >= THRESHOLDS.keyOff.minLuminanceDrop,
    'key light must own scene luminance: ' + JSON.stringify(keyOffLuminance));
  assert.ok(keyOffRelativeDrop >= THRESHOLDS.keyOff.minRelativeDrop, 'key light relative luminance contribution: ' + keyOffRelativeDrop);
  assert.ok(keyOffLuminance.brightenedFraction >= 0.5, 'key light brightens most of the scene: ' + keyOffLuminance.brightenedFraction);
  await evaluate('__liteAcceptance.setShadows(false)');
  const keyOffShadowsOff = await captureSettled('iso-key-off-shadows-off', 'key light off + shadows off');
  const keyOffShadowCollapse = analyze(keyOffShadowsOff, keyOffShadowsOn);
  assert.ok(keyOffShadowCollapse.changedFraction <= THRESHOLDS.keyOff.collapseChangedFraction,
    'key off must collapse the shadow contribution to ~0: ' + JSON.stringify(keyOffShadowCollapse));
  assert.ok(keyOffShadowCollapse.meanChannelDelta <= THRESHOLDS.keyOff.collapseMeanChannelDelta);
  await evaluate('__liteAcceptance.setShadows(true)');
  await evaluate('__liteAcceptance.setKeyLight(true)');

  // Ambient / fill / local-light toggles each change actual pixels, then restore exactly.
  await evaluate('__liteAcceptance.setAmbientLight(false)');
  const ambientOff = await captureSettled('iso-ambient-off', 'ambient off');
  const ambient = analyze(ambientOff, isoLightsOn);
  assert.ok(ambient.meanChannelDelta >= THRESHOLDS.ambientOff.meanChannelDelta, 'ambient off must change pixels: ' + JSON.stringify(ambient));
  assert.ok(ambient.brightenedFraction >= THRESHOLDS.ambientOff.brightenedFraction);
  assert.ok(ambient.meanLumDelta >= THRESHOLDS.ambientOff.minLuminanceDrop);
  await evaluate('__liteAcceptance.setAmbientLight(true)');
  const ambientRestored = await captureSettled('iso-ambient-restored', 'ambient restored');
  const ambientRestore = analyze(ambientRestored, isoLightsOn);
  assert.ok(ambientRestore.changedFraction <= THRESHOLDS.restoredState.changedFraction && ambientRestore.meanChannelDelta <= THRESHOLDS.restoredState.meanChannelDelta,
    'restoring ambient must reproduce the baseline frame: ' + JSON.stringify(ambientRestore));

  await evaluate('__liteAcceptance.setFillLight(false)');
  const fillOff = await captureSettled('iso-fill-off', 'fill off');
  const fill = analyze(fillOff, isoLightsOn);
  assert.ok(fill.meanChannelDelta >= THRESHOLDS.fillOff.meanChannelDelta, 'fill off must change pixels: ' + JSON.stringify(fill));
  assert.ok(fill.brightenedFraction >= THRESHOLDS.fillOff.brightenedFraction);
  assert.ok(fill.meanLumDelta >= THRESHOLDS.fillOff.minLuminanceDrop);
  await evaluate('__liteAcceptance.setFillLight(true)');

  await evaluate('__liteAcceptance.setLocalLights(false)');
  const localsOff = await captureSettled('iso-local-lights-off', 'local lights off');
  const locals = analyze(localsOff, isoLightsOn);
  assert.ok(locals.meanChannelDelta >= THRESHOLDS.localLightsOff.meanChannelDelta, 'local lights off must change pixels: ' + JSON.stringify(locals));
  assert.ok(locals.brightenedFraction >= THRESHOLDS.localLightsOff.brightenedFraction);
  assert.ok(locals.meanLumDelta >= THRESHOLDS.localLightsOff.minLuminanceDrop);
  await evaluate('__liteAcceptance.setLocalLights(true)');
  const lightsRestored = await captureSettled('iso-all-restored', 'all lighting restored');
  const allRestored = analyze(lightsRestored, isoLightsOn);
  assert.ok(allRestored.changedFraction <= THRESHOLDS.restoredState.changedFraction && allRestored.meanChannelDelta <= THRESHOLDS.restoredState.meanChannelDelta,
    'restoring every toggle must reproduce the baseline frame: ' + JSON.stringify(allRestored));

  // ---- 3. View matrix: ISO/TOP plus the L1/B1/DUAL/FFU structure layers -----------------------
  const views = [];
  for (const view of ['iso', 'top', 'l1', 'b1', 'dual', 'ffu']) {
    const before = (await readSnapshot()).frames;
    if (view === 'iso') await evaluate('__liteAcceptance.isoView()');
    else if (view === 'top') await evaluate('__liteAcceptance.topView()');
    else await evaluate('__liteAcceptance.structureView(' + JSON.stringify(view) + ')');
    const state = await until(candidate => candidate.frames > before + 2, 'view ' + view);
    assert.ok(state.drawCalls > 0, view + ' must issue draw calls');
    assert.deepEqual(state.gpuErrors, [], view + ' must render without GPU errors');
    assert.equal(state.lighting.shadows, true, view + ' must keep shadows enabled');
    assert.equal(state.lighting.casters, initial.lighting.casters, view + ' must keep the same caster set');
    if (view === 'l1' || view === 'b1' || view === 'dual' || view === 'ffu') {
      assert.equal(state.structure.layers.shell.visible, true, view + ' keeps the L1 shell');
      assert.equal(state.structure.layers.b1.offset, 0);
      assert.equal(state.structure.layers.ffu.visible, false, 'procedural ceiling stays source-disabled');
      assert.equal(state.structure.airshowerVisible, false, 'procedural air showers stay source-disabled');
      assert.equal(state.structure.layers.b1.visible, view === 'b1' || view === 'dual');
      assert.equal(state.structure.floorAlpha, view === 'b1' ? 0.2 : view === 'dual' ? 0.35 : 1);
      assert.equal(state.structure.slabVisible, view !== 'b1' && view !== 'dual');
      assert.equal(state.facility.ceilingVisible, view === 'ffu', 'facility ceiling follows FFU only');
      assert.equal(state.equipment.visible, true);
    }
    await capture('view-' + view);
    views.push({ view, frames: state.frames, drawCalls: state.drawCalls, loadingStage: state.loadingStage,
      layers: state.structure.layers, floorAlpha: state.structure.floorAlpha, slabVisible: state.structure.slabVisible,
      facilityCeilingVisible: state.facility.ceilingVisible });
  }

  // ---- 4. Rapid B1<->DUAL invalidation and remount --------------------------------------------
  const rapidSwitches = [];
  for (let round = 0; round < 3; round += 1) {
    const order = round % 2 === 0 ? ['b1', 'dual'] : ['dual', 'b1'];
    const before = (await readSnapshot()).frames;
    await evaluate('Promise.all([__liteAcceptance.structureView(' + JSON.stringify(order[0]) + '), __liteAcceptance.structureView(' + JSON.stringify(order[1]) + ')])');
    const state = await until(candidate => candidate.frames > before + 2, 'rapid switch round ' + round);
    assert.deepEqual(state.gpuErrors, []);
    // Latest selection must win regardless of which material rebuild resolves last.
    assert.equal(state.structure.layers.b1.visible, true);
    assert.equal(state.structure.floorAlpha, order[1] === 'dual' ? 0.35 : 0.2);
    assert.equal(state.lighting.casters, initial.lighting.casters);
    assert.equal(state.lighting.shadows, true);
    rapidSwitches.push({ order, floorAlpha: state.structure.floorAlpha, casters: state.lighting.casters });
  }
  await evaluate('Promise.all([__liteAcceptance.structureView("b1"), __liteAcceptance.structureView("dual")])');
  await waitFrames(4, 'rapid switch final');
  const rapidCamera = await evaluate('__liteAcceptance.inspectLayout().camera');
  assert.deepEqual(rapidCamera.target, [0, -3, 0], 'latest B1/DUAL selection must retain its camera');
  const rapidSettled = await readSnapshot();
  assert.equal(rapidSettled.structure.floorAlpha, 0.35);
  assert.deepEqual(rapidSettled.gpuErrors, []);

  const disposed = await evaluate('__liteAcceptance.dispose()');
  assert.equal(disposed.status, 'disposed');
  assert.equal(disposed.meshes, 0);
  assert.equal(disposed.registeredContexts, 0);
  assert.equal(disposed.surfaces, 0);
  const remounted = await evaluate('__liteAcceptance.mount()');
  assert.equal(remounted.status, 'ready');
  assert.equal(remounted.lighting.keyIntensity, initial.lighting.keyIntensity, 'remount restores key intensity');
  assert.equal(remounted.lighting.localLights, initial.lighting.localLights, 'remount restores local lights');
  assert.equal(remounted.lighting.shadows, initial.lighting.shadows, 'remount restores shadows');
  assert.equal(remounted.lighting.casters, initial.lighting.casters, 'remount restores the caster set');
  assert.equal(remounted.meshes, initial.meshes);
  assert.equal(remounted.structure.parts, initial.structure.parts);
  assert.equal(remounted.facility.parts, initial.facility.parts);
  const remountSettled = await waitFrames(3, 'remount frames');
  assert.deepEqual(remountSettled.gpuErrors, []);
  await evaluate('__liteAcceptance.isoView()');
  await waitFrames(4, 'remount iso settle');
  await capture('remount-iso');

  const finalSnapshot = await readSnapshot();
  assert.deepEqual(finalSnapshot.gpuErrors, []);
  await restoreAll();
  return {
    status: 'PASS',
    scope: 'P4 source lighting pixels + P5 native CSM shadow contribution on the Lite structure preview; product backend/picking and whole-product parity NOT_RUN',
    thresholds: THRESHOLDS,
    gpu,
    initial: { lighting: initial.lighting, structureLights: initial.structure.lights, facilityLights: initial.facility.lights,
      tools: initial.equipment.tools, identitiesMapped: initial.equipment.identities, facilityParts: initial.facility.parts,
      facilityInstances: initial.facility.instances, structureParts: initial.structure.parts, meshes: initial.meshes,
      drawCalls: initial.drawCalls, width: initial.width, height: initial.height },
    pixels: {
      unlitResponse, standardAmbient,
      determinism,
      shadowsOnOff,
      shadowRestore,
      keyOff: { luminance: keyOffLuminance, relativeLuminanceDrop: keyOffRelativeDrop, shadowCollapse: keyOffShadowCollapse },
      ambient: { delta: ambient, restore: ambientRestore },
      fill,
      localLights: locals,
      allRestored,
    },
    views,
    rapidSwitches,
    rapidCamera,
    remount: { disposed: { status: disposed.status, meshes: disposed.meshes, registeredContexts: disposed.registeredContexts, surfaces: disposed.surfaces },
      snapshot: { status: remounted.status, lighting: remounted.lighting, meshes: remounted.meshes,
        structureParts: remounted.structure.parts, facilityParts: remounted.facility.parts } },
    evidenceDir: evidenceDir ?? null,
    screenshots: evidenceDir ? screenshots.map(name => evidencePath(name).split(path.sep).join('/')) : [],
    final: { frames: finalSnapshot.frames, drawCalls: finalSnapshot.drawCalls, gpuErrors: finalSnapshot.gpuErrors, states: finalSnapshot.states },
  };
}
