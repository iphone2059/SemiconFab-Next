// @ts-nocheck — real-WebGPU CDP acceptance for the Lite preview's native CSM shadows.
// Node 26 executes this .ts suite with native type stripping (see tools/run_twin_browser.mjs).
// The suite proves the CSM generator exists at the GPU-resource level (depth32float 2048^2,
// depthOrArrayLayers = numCascades 2, csm static cache), captures the exact caster set passed to
// setShadowTaskCasterMeshes and checks it against selectLiteShadowCasters in lite-shadow.test.ts,
// and measures the actual shadow contribution from screenshots rather than state alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './support/png.ts';

// Scene ROI: same margin as the lighting suite so DOM chrome cannot contribute.
const ROI = { x0: 0.05, x1: 0.95, y0: 0.10, y1: 0.92 };
const DETERMINISM = { changedFraction: 0.0005, meanChannelDelta: 0.02, meanLumDelta: 0.02 };
const THRESHOLDS = {
  csm: { mapSize: 2048, cascades: 2, minCasters: 150, baselineCasters: 195 },
  shadowsIso: { changedFraction: 0.04, darkenedFraction: 0.03, meanChannelDelta: 1.2,
    meanChannelDeltaAmongChanged: 12, medianChannelDeltaAmongChanged: 10 },
  shadowsTop: { changedFraction: 0.03, darkenedFraction: 0.02, meanChannelDelta: 1.0,
    meanChannelDeltaAmongChanged: 12, medianChannelDeltaAmongChanged: 10 },
  b1Contribution: { changedFraction: 0.02, darkenedFraction: 0.015, meanChannelDelta: 0.8,
    medianChannelDeltaAmongChanged: 8 },
  remountContribution: { changedFraction: 0.03, darkenedFraction: 0.02, meanChannelDelta: 1.0 },
  keyOff: { collapseChangedFraction: 0.001, collapseMeanChannelDelta: 0.02, minLuminanceDrop: 30, minRelativeDrop: 0.10 },
  determinism: DETERMINISM,
};

// TEST-ONLY instrumentation injected before any page script and removed after the suite:
//  - records every GPU texture descriptor (proves the CSM depth resources really exist on the device);
//  - records the explicit caster array produced by selectLiteShadowCasters (the same array passed to
//    setShadowTaskCasterMeshes), so floor/slab/line/status caster leaks are checked on real meshes.
const INSTRUMENTATION = `(() => {
  const textureLog = [];
  Object.defineProperty(window, '__gpuTextureLog', { value: textureLog, configurable: true });
  if (typeof GPUDevice !== 'undefined') {
    const originalCreateTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      try {
        const size = descriptor && descriptor.size;
        const dims = Array.isArray(size) ? size : size ? [size.width, size.height, size.depthOrArrayLayers] : [];
        textureLog.push({ format: descriptor && descriptor.format, width: dims[0], height: dims[1],
          layers: dims[2] === undefined ? 1 : dims[2], label: descriptor && descriptor.label });
      } catch (error) { textureLog.push({ error: String(error) }); }
      return originalCreateTexture.call(this, descriptor);
    };
  }
  const nativeFilter = Array.prototype.filter;
  const isMeshLike = value => value && typeof value === 'object' && typeof value.name === 'string'
    && 'material' in value && 'metadata' in value;
  Array.prototype.filter = function (callback, thisArg) {
    const result = nativeFilter.call(this, callback, thisArg);
    try {
      if (Array.isArray(this) && this.length > 400 && result.length > 50 && result.length < this.length
          && isMeshLike(this[0]) && isMeshLike(this[Math.floor(this.length / 2)])) {
        const describe = mesh => {
          const material = mesh.material;
          return { name: mesh.name, visible: mesh.visible !== false,
            alpha: material ? material.alpha : undefined, alphaBlend: material ? material.alphaBlend : undefined,
            useVertexAlpha: material ? material.useVertexAlpha : undefined,
            materialName: material ? material.name : undefined,
            materialClass: material ? String(material.constructor && material.constructor.name) : undefined,
            staticShadowCaster: mesh.metadata ? mesh.metadata.staticShadowCaster : undefined };
        };
        const output = result.map(describe);
        const outputNames = new Set(output.map(mesh => mesh.name));
        const excluded = [];
        for (let i = 0; i < this.length; i += 1) if (!outputNames.has(this[i].name)) excluded.push(describe(this[i]));
        window.__liteCasterProbe = { inputLength: this.length, outputLength: result.length, output, excluded };
      }
    } catch (error) { /* instrumentation must never disturb the page */ }
    return result;
  };
})();`;

/** Decode a screenshot and compare candidate a against reference b over the scene ROI. */
function analyze(a, b) {
  const x0 = Math.floor(a.width * ROI.x0), x1 = Math.ceil(a.width * ROI.x1);
  const y0 = Math.floor(a.height * ROI.y0), y1 = Math.ceil(a.height * ROI.y1);
  const histogram = new Uint32Array(766);
  const changedHistogram = new Uint32Array(766);
  let sum = 0, sumChanged = 0, changed = 0, pixels = 0;
  let lumA = 0, lumB = 0, darkened = 0, darkenedSum = 0, brightened = 0, brightenedSum = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.channels, ib = (y * b.width + x) * b.channels;
      const delta = Math.abs(a.data[ia] - b.data[ib]) + Math.abs(a.data[ia + 1] - b.data[ib + 1]) + Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const la = 0.2126 * a.data[ia] + 0.7152 * a.data[ia + 1] + 0.0722 * a.data[ia + 2];
      const lb = 0.2126 * b.data[ib] + 0.7152 * b.data[ib + 1] + 0.0722 * b.data[ib + 2];
      lumA += la; lumB += lb; sum += delta; histogram[delta] += 1;
      if (delta > 9) { changed += 1; sumChanged += delta; changedHistogram[delta] += 1; }
      if (lb < la - 3) { darkened += 1; darkenedSum += la - lb; }
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
    meanLumA: lumA / pixels, meanLumB: lumB / pixels, meanLumDelta: (lumB - lumA) / pixels,
    meanChannelDelta: sum / (pixels * 3), changedFraction: changed / pixels,
    darkenedFraction: darkened / pixels, brightenedFraction: brightened / pixels,
    meanChannelDeltaAmongChanged: sumChanged / (Math.max(1, changed) * 3),
    medianChannelDeltaAmongChanged: percentile(changedHistogram, Math.max(1, changed), 0.5) / 3,
    meanLuminanceReductionAmongDarkened: darkenedSum / Math.max(1, darkened),
    p90ChannelDelta: percentile(histogram, pixels, 0.9) / 3,
    p99ChannelDelta: percentile(histogram, pixels, 0.99) / 3,
    maxChannelDelta: percentile(histogram, pixels, 0.9999) / 3,
  };
}

export async function runLiteShadowAcceptance(command, baseUrl) {
  const evidenceDir = process.env.LITE_EVIDENCE_DIR;
  if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
  const screenshots = [];
  const evidencePath = name => evidenceDir ? path.join(evidenceDir, 'shadow-' + name + '.png') : undefined;
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
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
          frames: last?.frames, states: last?.states, gpuErrors: last?.gpuErrors }));
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
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
  const csmTextures = () => evaluate(`window.__gpuTextureLog.filter(texture => texture.format === 'depth32float')`);
  const casterSummary = () => evaluate(`(() => {
    const probe = window.__liteCasterProbe;
    if (!probe) return null;
    const violations = {
      transparent: probe.output.filter(mesh => mesh.alpha !== undefined && mesh.alpha < 1).map(mesh => mesh.name),
      alphaBlend: probe.output.filter(mesh => mesh.alphaBlend === true).map(mesh => mesh.name),
      vertexAlpha: probe.output.filter(mesh => mesh.useVertexAlpha !== undefined).map(mesh => mesh.name),
      lineMaterial: probe.output.filter(mesh => mesh.materialName === 'LineMaterial' || mesh.materialClass === 'LineMaterial').map(mesh => mesh.name),
      explicitNonCaster: probe.output.filter(mesh => mesh.staticShadowCaster === false).map(mesh => mesh.name),
      forbiddenNames: probe.output.filter(mesh => mesh.name === 'procedural-floor' || mesh.name === 'procedural-slab'
        || mesh.name === 'subfab-floor' || /-wire$/.test(mesh.name) || /status/i.test(mesh.name)).map(mesh => mesh.name),
    };
    const excludedNames = probe.excluded.map(mesh => mesh.name);
    return { inputLength: probe.inputLength, outputLength: probe.outputLength, excludedCount: probe.inputLength - probe.outputLength,
      casterNames: probe.output.map(mesh => mesh.name), violations,
      excluded: { sampled: probe.excluded.length,
        floor: excludedNames.filter(name => name === 'procedural-floor').length,
        slab: excludedNames.filter(name => name === 'procedural-slab').length,
        subfabFloor: excludedNames.filter(name => name === 'subfab-floor').length,
        lineMaterial: probe.excluded.filter(mesh => mesh.materialName === 'LineMaterial').length,
        explicitNonCaster: probe.excluded.filter(mesh => mesh.staticShadowCaster === false).length,
        transparent: probe.excluded.filter(mesh => mesh.alpha !== undefined && mesh.alpha < 1).length } };
  })()`);
  const assertCsmState = (label, state) => {
    assert.equal(state.lighting.shadows, true, label + ': native CSM shadows enabled');
    assert.equal(state.lighting.keyIntensity, 1.15, label + ': source key light intensity owns the shadow');
    assert.ok(state.lighting.casters > THRESHOLDS.csm.minCasters, label + ': caster count ' + state.lighting.casters + ' > ' + THRESHOLDS.csm.minCasters);
    assert.deepEqual(state.gpuErrors, [], label + ': no GPU errors');
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Log.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  const injection = await command('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });
  try {
    await command('Page.navigate', { url: baseUrl + '/?scene=structure' });
    const initial = await until(state => state.status === 'ready' && state.frames > 2, 'structure scene ready', 60000);
    await evaluate("document.querySelectorAll('output, nav').forEach(element => element.style.display = 'none')");
    const gpu = await evaluate(`(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return { secure: isSecureContext, vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, userAgent: navigator.userAgent };
    })()`);
    const initialCsm = await csmTextures();
    const initialCasters = await casterSummary();
    assert.ok(initialCasters, 'caster instrumentation captured selectLiteShadowCasters output');

    // ---- 1. CSM generator and explicit caster set (GPU resources + real mesh identities) -------
    assertCsmState('initial', initial);
    assert.ok(initial.lighting.casters > 150, '2026-10-26 baseline has 195 casters; asserting > 150');
    assert.ok(initialCsm.length > 0, 'CSM depth textures must be allocated on the GPU device');
    assert.ok(initialCsm.every(texture => texture.width === THRESHOLDS.csm.mapSize && texture.height === THRESHOLDS.csm.mapSize),
      'every CSM cascade map is 2048x2048: ' + JSON.stringify(initialCsm));
    assert.ok(initialCsm.some(texture => texture.layers === THRESHOLDS.csm.cascades),
      'CSM depth32float map is a 2-layer depth array (numCascades 2): ' + JSON.stringify(initialCsm));
    assert.ok(initialCsm.some(texture => texture.label === 'csm-static-cache'),
      'enableCsmStaticCache allocated the static cache texture: ' + JSON.stringify(initialCsm));
    // No floor/slab/line/status caster leak: mirrors selectLiteShadowCasters exclusions proven by
    // web_app/tests/lite-shadow.test.ts. The captured output is the exact array handed to
    // setShadowTaskCasterMeshes, so these checks are on the real composed 721-mesh scene.
    assert.equal(initialCasters.outputLength, initial.lighting.casters,
      'captured caster array length matches snapshot casters: ' + JSON.stringify({ probe: initialCasters, snapshot: initial.lighting }));
    const violations = initialCasters.violations;
    assert.ok(violations.transparent.length === 0, 'no transparent casters (mirrors lite-shadow.test.ts): ' + JSON.stringify(violations.transparent));
    assert.ok(violations.alphaBlend.length === 0, 'no alpha-blended casters: ' + JSON.stringify(violations.alphaBlend));
    assert.ok(violations.vertexAlpha.length === 0, 'no vertex-alpha line casters: ' + JSON.stringify(violations.vertexAlpha));
    assert.ok(violations.lineMaterial.length === 0, 'no LineMaterial casters: ' + JSON.stringify(violations.lineMaterial));
    assert.ok(violations.explicitNonCaster.length === 0, 'no staticShadowCaster=false meshes: ' + JSON.stringify(violations.explicitNonCaster));
    assert.ok(violations.forbiddenNames.length === 0, 'no floor/slab/wire/status-name casters: ' + JSON.stringify(violations.forbiddenNames));
    assert.equal(initialCasters.excluded.floor >= 1, true, 'procedural-floor is excluded from casters');
    assert.equal(initialCasters.excluded.slab >= 1, true, 'procedural-slab is excluded from casters');
    assert.ok(initialCasters.excluded.lineMaterial >= 1, 'line/status geometry is excluded from casters');
    assert.ok(initialCasters.excluded.explicitNonCaster >= 1, 'explicit non-casting status parts are excluded');
    assert.equal(initialCasters.excludedCount, initialCasters.inputLength - initialCasters.outputLength);
    assert.ok(initialCasters.excludedCount > 0);

    // ---- 2. ISO shadow contribution, determinism, and key ownership ---------------------------
    await evaluate('__liteAcceptance.isoView()');
    await waitFrames(6, 'iso settle');
    assert.equal(initial.facility.labels, 2, 'both source airlock label handles exist');
    const labelsOn = await capture('labels-on');
    await evaluate('__liteAcceptance.setLabelsVisible(false)');
    const labelContribution = analyze(await captureSettled('labels-off', 'labels hidden'), labelsOn);
    assert.ok(labelContribution.meanChannelDelta > 0.03 && labelContribution.changedFraction > 0.0005,
      'native labels must visibly contribute before recovery comparison: ' + JSON.stringify(labelContribution));
    await evaluate('__liteAcceptance.setLabelsVisible(true)');
    await waitFrames(4, 'labels restored');
    const isoOnA = await capture('iso-shadows-on-a');
    const isoOnB = await capture('iso-shadows-on-b');
    const isoDeterminism = analyze(isoOnB, isoOnA);
    assert.ok(isoDeterminism.changedFraction <= DETERMINISM.changedFraction && isoDeterminism.meanChannelDelta <= DETERMINISM.meanChannelDelta,
      'two settled ISO captures must be deterministic: ' + JSON.stringify(isoDeterminism));
    await evaluate('__liteAcceptance.setShadows(false)');
    const isoOff = await captureSettled('iso-shadows-off', 'shadows off');
    const isoContribution = analyze(isoOff, isoOnA);
    assert.ok(isoContribution.darkenedFraction >= THRESHOLDS.shadowsIso.darkenedFraction,
      'ISO shadow contribution must darken the ROI: ' + JSON.stringify(isoContribution));
    assert.ok(isoContribution.changedFraction >= THRESHOLDS.shadowsIso.changedFraction);
    assert.ok(isoContribution.meanChannelDelta >= THRESHOLDS.shadowsIso.meanChannelDelta);
    assert.ok(isoContribution.meanChannelDeltaAmongChanged >= THRESHOLDS.shadowsIso.meanChannelDeltaAmongChanged);
    assert.ok(isoContribution.medianChannelDeltaAmongChanged >= THRESHOLDS.shadowsIso.medianChannelDeltaAmongChanged);
    await evaluate('__liteAcceptance.setShadows(true)');
    // Key off: shadows must lose their contribution (the key is the only shadow caster).
    await evaluate('__liteAcceptance.setKeyLight(false)');
    const keyOffShadowsOn = await captureSettled('iso-key-off-shadows-on', 'key light off');
    const keyOffLuminance = analyze(keyOffShadowsOn, isoOnA);
    assert.ok(keyOffLuminance.meanLumDelta >= THRESHOLDS.keyOff.minLuminanceDrop, 'key off must reduce scene luminance: ' + JSON.stringify(keyOffLuminance));
    assert.ok(keyOffLuminance.meanLumDelta / keyOffLuminance.meanLumB >= THRESHOLDS.keyOff.minRelativeDrop);
    await evaluate('__liteAcceptance.setShadows(false)');
    const keyOffShadowsOff = await captureSettled('iso-key-off-shadows-off', 'key off + shadows off');
    const keyOffCollapse = analyze(keyOffShadowsOff, keyOffShadowsOn);
    assert.ok(keyOffCollapse.changedFraction <= THRESHOLDS.keyOff.collapseChangedFraction,
      'key off must eliminate the shadow contribution: ' + JSON.stringify(keyOffCollapse));
    assert.ok(keyOffCollapse.meanChannelDelta <= THRESHOLDS.keyOff.collapseMeanChannelDelta);
    await evaluate('__liteAcceptance.setShadows(true)');
    await evaluate('__liteAcceptance.setKeyLight(true)');

    // ---- 3. TOP shadow contribution ----------------------------------------------------------
    await evaluate('__liteAcceptance.topView()');
    await waitFrames(6, 'top settle');
    const topOn = await capture('top-shadows-on');
    await evaluate('__liteAcceptance.setShadows(false)');
    const topOff = await captureSettled('top-shadows-off', 'top shadows off');
    const topContribution = analyze(topOff, topOn);
    assert.ok(topContribution.darkenedFraction >= THRESHOLDS.shadowsTop.darkenedFraction,
      'TOP shadow contribution must darken the ROI: ' + JSON.stringify(topContribution));
    assert.ok(topContribution.changedFraction >= THRESHOLDS.shadowsTop.changedFraction);
    assert.ok(topContribution.meanChannelDelta >= THRESHOLDS.shadowsTop.meanChannelDelta);
    assert.ok(topContribution.medianChannelDeltaAmongChanged >= THRESHOLDS.shadowsTop.medianChannelDeltaAmongChanged);
    await evaluate('__liteAcceptance.setShadows(true)');

    // ---- 4. B1/DUAL layer switches invalidate/refit without errors ---------------------------
    const beforeB1 = (await readSnapshot()).frames;
    await evaluate('__liteAcceptance.structureView("b1")');
    const b1State = await until(state => state.frames > beforeB1 + 2, 'b1 layer switch');
    assert.equal(b1State.structure.floorAlpha, 0.2);
    assert.equal(b1State.structure.layers.b1.visible, true);
    assertCsmState('b1 switch', b1State);
    assert.equal(b1State.lighting.casters, initial.lighting.casters, 'B1 switch keeps the caster set');
    assert.ok(b1State.drawCalls > 0);
    const b1On = await capture('b1-shadows-on');
    await evaluate('__liteAcceptance.setShadows(false)');
    const b1Off = await captureSettled('b1-shadows-off', 'b1 shadows off');
    const b1Contribution = analyze(b1Off, b1On);
    assert.ok(b1Contribution.darkenedFraction >= THRESHOLDS.b1Contribution.darkenedFraction,
      'shadows must still render after the B1 material/visibility rebuild: ' + JSON.stringify(b1Contribution));
    assert.ok(b1Contribution.changedFraction >= THRESHOLDS.b1Contribution.changedFraction);
    assert.ok(b1Contribution.meanChannelDelta >= THRESHOLDS.b1Contribution.meanChannelDelta);
    assert.ok(b1Contribution.medianChannelDeltaAmongChanged >= THRESHOLDS.b1Contribution.medianChannelDeltaAmongChanged);
    await evaluate('__liteAcceptance.setShadows(true)');
    const beforeDual = (await readSnapshot()).frames;
    await evaluate('__liteAcceptance.structureView("dual")');
    const dualState = await until(state => state.frames > beforeDual + 2, 'dual layer switch');
    assert.equal(dualState.structure.floorAlpha, 0.35);
    assertCsmState('dual switch', dualState);
    assert.equal(dualState.lighting.casters, initial.lighting.casters);
    await capture('dual-shadows-on');
    await evaluate('Promise.all([__liteAcceptance.structureView("b1"), __liteAcceptance.structureView("dual")])');
    await waitFrames(4, 'rapid b1/dual');
    const rapidState = await readSnapshot();
    assert.equal(rapidState.structure.floorAlpha, 0.35, 'latest B1/DUAL selection wins');
    assert.deepEqual(rapidState.gpuErrors, []);
    assert.equal(rapidState.lighting.casters, initial.lighting.casters);

    // ---- 5. Dispose + remount recreates shadows ----------------------------------------------
    const disposed = await evaluate('__liteAcceptance.dispose()');
    assert.equal(disposed.status, 'disposed');
    assert.equal(disposed.meshes, 0);
    assert.equal(disposed.registeredContexts, 0);
    const csmBeforeRemount = (await csmTextures()).length;
    const remounted = await evaluate('__liteAcceptance.mount()');
    assert.equal(remounted.status, 'ready');
    assertCsmState('remount', remounted);
    assert.equal(remounted.lighting.casters, initial.lighting.casters, 'remount recreates the same caster set');
    assert.equal(remounted.meshes, initial.meshes);
    const csmAfterRemount = await csmTextures();
    assert.ok(csmAfterRemount.length > csmBeforeRemount, 'remount allocates fresh CSM depth textures');
    assert.ok(csmAfterRemount.filter(texture => texture.width === 2048).length > 0);
    const remountCasters = await casterSummary();
    assert.ok(remountCasters, 'caster instrumentation captured the remounted caster array');
    assert.equal(remountCasters.outputLength, remounted.lighting.casters);
    assert.deepEqual(remountCasters.violations, { transparent: [], alphaBlend: [], vertexAlpha: [], lineMaterial: [],
      explicitNonCaster: [], forbiddenNames: [] });
    await waitFrames(3, 'remount frames');
    await evaluate('__liteAcceptance.isoView()');
    await waitFrames(5, 'remounted iso settle');
    const remountOn = await capture('remount-shadows-on');
    await evaluate('__liteAcceptance.setShadows(false)');
    const remountOff = await captureSettled('remount-shadows-off', 'remount shadows off');
    const remountContribution = analyze(remountOff, remountOn);
    assert.ok(remountContribution.darkenedFraction >= THRESHOLDS.remountContribution.darkenedFraction,
      'remounted shadows must render a real contribution: ' + JSON.stringify(remountContribution));
    assert.ok(remountContribution.changedFraction >= THRESHOLDS.remountContribution.changedFraction);
    assert.ok(remountContribution.meanChannelDelta >= THRESHOLDS.remountContribution.meanChannelDelta);
    await evaluate('__liteAcceptance.setShadows(true)');

    // ---- 6. Three device losses under shadows on ---------------------------------------------
    // Recovery must preserve a current disabled-light state, not just the default rig.
    await evaluate('__liteAcceptance.setAmbientLight(false); __liteAcceptance.setFillLight(false); __liteAcceptance.setLocalLights(false)');
    const preLossImage = await captureSettled('before-loss', 'before-loss label baseline');
    const preLossContexts = (await readSnapshot()).registeredContexts;
    const recoveries = [];
    for (let loss = 1; loss <= 3; loss += 1) {
      const beforeLoss = (await csmTextures()).length;
      await evaluate('__liteAcceptance.loseDevice()');
      const recovered = await until(state => state.status === 'ready'
        && state.states.filter(entry => entry === 'lost').length === loss, 'device recovery ' + loss, 60000);
      const advanced = await waitFrames(3, 'resumed frames after loss ' + loss);
      assertCsmState('recovery ' + loss, advanced);
      assert.equal(advanced.lighting.casters, initial.lighting.casters, 'recovery ' + loss + ' restores the caster set');
      assert.equal(advanced.meshes, initial.meshes, 'recovery ' + loss + ' restores the scene mesh set');
      assert.ok(advanced.frames > recovered.frames, 'recovery ' + loss + ' keeps rendering');
      assert.equal(advanced.registeredContexts, preLossContexts, 'recovery must not accumulate label contexts');
      const recoveredImage = await capture('after-loss-' + loss);
      const recoveredPixels = analyze(recoveredImage, preLossImage);
      assert.ok(recoveredPixels.meanChannelDelta <= DETERMINISM.meanChannelDelta
        && recoveredPixels.changedFraction <= DETERMINISM.changedFraction,
      'device recovery must preserve visible labels and scene pixels: ' + JSON.stringify(recoveredPixels));
      const afterLoss = await csmTextures();
      assert.ok(afterLoss.length > beforeLoss, 'recovery ' + loss + ' allocates fresh CSM depth textures: '
        + JSON.stringify({ before: beforeLoss, after: afterLoss.length }));
      assert.ok(afterLoss.filter(texture => texture.width === THRESHOLDS.csm.mapSize).length > 0);
      recoveries.push({ loss, frames: advanced.frames, casters: advanced.lighting.casters,
        states: advanced.states.filter(entry => entry === 'lost').length, csmTextures: afterLoss.length,
        recoveredPixels, registeredContexts: advanced.registeredContexts });
    }

    await evaluate('__liteAcceptance.setAmbientLight(true); __liteAcceptance.setFillLight(true); __liteAcceptance.setLocalLights(true)');
    const restoredAfterLoss = analyze(await captureSettled('after-loss-restored', 'restore lights after losses'), remountOn);
    assert.ok(restoredAfterLoss.meanChannelDelta <= DETERMINISM.meanChannelDelta
      && restoredAfterLoss.changedFraction <= DETERMINISM.changedFraction,
    'restoring lights after recovery must reproduce the original rig: ' + JSON.stringify(restoredAfterLoss));

    const finalSnapshot = await readSnapshot();
    assert.deepEqual(finalSnapshot.gpuErrors, []);
    const finalCsm = await csmTextures();
    return {
      status: 'PASS',
      scope: 'P5 native CSM shadows on the Lite structure preview; whole-product parity and performance NOT_RUN',
      thresholds: THRESHOLDS,
      csm: { initialTextures: initialCsm, finalTextureCount: finalCsm.length,
        generator: { mapSize: THRESHOLDS.csm.mapSize, cascades: THRESHOLDS.csm.cascades,
          depthFormat: 'depth32float', staticCache: 'csm-static-cache', recoverable: true } },
      casters: { observed: initial.lighting.casters, baseline: THRESHOLDS.csm.baselineCasters,
        inputMeshes: initialCasters.inputLength, excluded: initialCasters.excludedCount,
        excludedDetail: initialCasters.excluded, casterNames: initialCasters.casterNames,
        violations: initialCasters.violations },
      gpu,
      pixels: { labelContribution, isoDeterminism, isoContribution, topContribution,
        keyOff: { luminance: keyOffLuminance, relativeLuminanceDrop: keyOffLuminance.meanLumDelta / keyOffLuminance.meanLumB, collapse: keyOffCollapse },
        b1Contribution, remountContribution, restoredAfterLoss },
      layers: { b1: { floorAlpha: b1State.structure.floorAlpha, casters: b1State.lighting.casters },
        dual: { floorAlpha: dualState.structure.floorAlpha, casters: dualState.lighting.casters },
        rapid: { floorAlpha: rapidState.structure.floorAlpha, casters: rapidState.lighting.casters } },
      lifecycle: { disposed: { status: disposed.status, meshes: disposed.meshes, registeredContexts: disposed.registeredContexts },
        remounted: { status: remounted.status, casters: remounted.lighting.casters, meshes: remounted.meshes },
        recoveries },
      initial: { lighting: initial.lighting, meshes: initial.meshes, drawCalls: initial.drawCalls,
        width: initial.width, height: initial.height },
      evidenceDir: evidenceDir ?? null,
      screenshots: evidenceDir ? screenshots.map(name => evidencePath(name).split(path.sep).join('/')) : [],
      final: { frames: finalSnapshot.frames, drawCalls: finalSnapshot.drawCalls, states: finalSnapshot.states, gpuErrors: finalSnapshot.gpuErrors },
    };
  } finally {
    await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
  }
}
