// @ts-nocheck — native Lite product acceptance on the real /twin page (CDP transport).
import assert from 'node:assert/strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runLiteProductAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, label = expression, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression).catch(() => false)) return;
      await sleep(120);
    }
    throw new Error('timeout: ' + label);
  }
  const key = async keyName => {
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code: keyName, windowsVirtualKeyCode: keyName === 'Escape' ? 27 : 0 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: keyName === 'Escape' ? 27 : 0 });
  };
  const clickPoint = async (x, y, clickCount = 1, button = 'left') => {
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
  };
  const diag = () => evaluate('window.__SEMICONFAB_PERF__.getDiagnostics()');
  const pose = () => evaluate('window.__SEMICONFAB_PERF__.getCameraPose()');
  const lifecycle = () => evaluate('window.__SEMICONFAB_PERF__.getLifecycle()');
  const clickId = async id => { await evaluate('document.querySelector(' + JSON.stringify('#' + id) + ').click()'); };
  const clickSelector = async selector => { await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); };
  const setRange = async (selector, value) => evaluate('(() => { const slider = document.querySelector(' + JSON.stringify(selector) + '); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, \'value\').set; setter.call(slider, ' + JSON.stringify(String(value)) + '); slider.dispatchEvent(new Event(\'input\', { bubbles: true })); })()');
  const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
  const vectorNear = (actual, expected, tolerance) => actual && expected && expected.every((value, index) => near(actual[index], value, tolerance));

  await command('Page.enable'); await command('Runtime.enable');
  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  await until('!!document.querySelector(".twin-page")', 'twin page');
  await evaluate('localStorage.setItem("semicon_twin_onboarding_dismissed","1")');
  if (await evaluate('!!document.querySelector(".twin-onboarding")')) {
    await evaluate('document.querySelector(".twin-onboarding-head button").click()');
  }
  await until('document.querySelector(".twin-status")?.getAttribute("title")?.startsWith("WebGPU ·")', 'first product frame', 120000);
  await until('!!window.__SEMICONFAB_PERF__?.getDiagnostics', 'perf diagnostics');
  const result = { steps: [] };
  const record = (name, value) => { result.steps.push({ name, ok: true, value }); };

  // ---- C2: 121 tools, hover, click selection, double-click focus, Escape clear ----
  const before = await diag();
  assert.equal(before.motion.stats.total, 24, '24 OHT vehicles');
  assert.ok(before.meshCount > 500, 'full FAB mesh count');
  const projected = [];
  for (let index = 0; index < 121 && projected.length < 12; index += 1) {
    const point = await evaluate('window.__SEMICONFAB_PERF__.projectTool(' + index + ')');
    if (!point) continue;
    if (point.x < 430 || point.x > 1360 || point.y < 130 || point.y > 660) continue;
    projected.push({ index, ...point });
  }
  assert.ok(projected.length >= 3, 'projected tools inside the interaction area: ' + projected.length);
  let picked = null;
  let hoverSeen = false;
  for (const candidate of projected) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: candidate.x, y: candidate.y, buttons: 0 });
    for (let attempt = 0; attempt < 10 && !hoverSeen; attempt += 1) {
      await sleep(120);
      if (await evaluate('!!document.querySelector(".twin-hovercard")')) hoverSeen = true;
    }
    await clickPoint(candidate.x, candidate.y);
    await sleep(400);
    const state = await diag();
    if (state.selection.index !== null && state.selection.visible) { picked = { candidate, state }; break; }
  }
  assert.ok(picked, 'canvas pick selects a tool');
  const pickedIndex = picked.state.selection.index;
  assert.ok(hoverSeen, 'hover card appears over a canvas tool');
  assert.ok(await evaluate('!!document.querySelector(".twin-inspector")'), 'inspector opens on selection');
  record('pick', { index: pickedIndex, hover: hoverSeen, selectionVisible: picked.state.selection.visible });
  const reproject = await evaluate('window.__SEMICONFAB_PERF__.projectTool(' + pickedIndex + ')');
  assert.ok(reproject && Math.hypot(reproject.x - picked.candidate.x, reproject.y - picked.candidate.y) < 40, 'selected tool matches the click location');
  const poseBeforeFocus = await pose();
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 400, buttons: 0 });
  await sleep(200);
  // Deterministic gesture for the focus path: the browser's own double-click synthesis depends on
  // multi-click timing; the canvas handler is a public DOM dblclick listener.
  await evaluate('document.querySelector("canvas").dispatchEvent(new MouseEvent("dblclick", { clientX: ' + picked.candidate.x + ', clientY: ' + picked.candidate.y + ', bubbles: true }))');
  await sleep(900);
  const focused = await pose();
  assert.ok(focused, 'double-click focus returns a camera pose');
  const focusState = (await diag()).selection;
  // The selection box is authored in the Next RH domain; the native camera target reflects Z once.
  assert.ok(vectorNear(focused.target, [focusState.center[0], focused.target[1], -focusState.center[2]], 6), 'double-click focus targets the selected tool: target=' + JSON.stringify(focused.target) + ' center=' + JSON.stringify(focusState.center));
  assert.ok(Math.hypot(focused.position[0] - poseBeforeFocus.position[0], focused.position[2] - poseBeforeFocus.position[2]) > 0.5, 'double-click focus moves the camera');
  record('focus', focused);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 760, y: 400, button: 'left', buttons: 1, clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 400, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  await key('Escape');
  await until('window.__SEMICONFAB_PERF__.getDiagnostics().selection.index === null', 'escape clears selection', 5000);
  record('escape-clear', true);

  // ---- C3: camera presets, orbit, wheel zoom, resize ----
  const presetButton = label => evaluate('document.querySelector(\'[aria-label="' + label + '"]\').click()');
  await presetButton('Top'); await sleep(1300);
  assert.ok(vectorNear((await pose()).position, [0, 95, 0.1], 2), 'Top preset');
  await presetButton('ISO'); await sleep(1300);
  assert.ok(vectorNear((await pose()).position, [38, 48, 58], 2), 'ISO preset');
  await presetButton('Litho'); await sleep(1300);
  assert.ok(vectorNear((await pose()).position, [-21, 3.6, -12.5], 2), 'Litho preset');
  await presetButton('Airlock'); await sleep(1300);
  assert.ok(vectorNear((await pose()).position, [-12.5, 4.2, 7.5], 2), 'Airlock preset');
  record('camera-presets', true);
  const orbitBefore = await pose();
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 400, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900 + step * 12, y: 400 + step * 3, button: 'left', buttons: 1 });
    await sleep(30);
  }
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 996, y: 424, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const orbitAfter = await pose();
  assert.ok(Math.hypot(orbitAfter.position[0] - orbitBefore.position[0], orbitAfter.position[2] - orbitBefore.position[2]) > 0.5, 'orbit drag changes camera');
  const radiusOf = poseValue => Math.hypot(poseValue.position[0] - poseValue.target[0], poseValue.position[1] - poseValue.target[1], poseValue.position[2] - poseValue.target[2]);
  const radiusBeforeZoom = radiusOf(await pose());
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 760, y: 400, deltaX: 0, deltaY: -300 });
  await sleep(400);
  assert.ok(radiusOf(await pose()) < radiusBeforeZoom - 0.1, 'wheel zoom belongs to the page owner');
  await presetButton('ISO'); await sleep(1200);
  record('orbit-zoom', true);
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const resized = await evaluate('(() => { const canvas = document.querySelector("canvas"); const rect = canvas.getBoundingClientRect(); return { width: canvas.width, height: canvas.height, cssWidth: Math.round(rect.width) }; })()');
  assert.ok(resized.cssWidth === 1280, 'canvas follows the resized viewport: ' + JSON.stringify(resized));
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  assert.equal((await lifecycle()).statuses.includes('lost'), false, 'resize must not lose the device');
  record('resize', resized);

  // ---- C4: level state machine ----
  await clickId('level-btn-b1'); await sleep(1600);
  let level = await diag();
  assert.ok(near(level.structure.floorAlpha, 0.2, 0.02), 'B1 floor alpha ' + level.structure.floorAlpha);
  assert.equal(level.structure.b1Visible, true, 'B1 visible');
  assert.equal(level.structure.slabVisible, false, 'slab hidden below L1');
  assert.equal(level.facility.ceilingVisible, false, 'ceiling hidden at B1');
  record('level-B1', level.structure);
  await clickId('level-btn-dual'); await sleep(1600);
  level = await diag();
  assert.ok(near(level.structure.floorAlpha, 0.35, 0.02), 'DUAL floor alpha ' + level.structure.floorAlpha);
  assert.equal(level.structure.b1Visible, true, 'DUAL keeps B1 visible');
  record('level-DUAL', level.structure);
  await clickId('level-btn-exploded');
  await until('window.__SEMICONFAB_PERF__.getWorld().explodeFactor > 0.98', 'explode reaches 100%', 20000);
  await sleep(400);
  level = await diag();
  assert.ok(near(level.structure.floorAlpha, 0.55, 0.03), 'EXPLODED floor alpha ' + level.structure.floorAlpha);
  assert.equal(level.facility.ceilingVisible, true, 'exploded ceiling visible');
  assert.ok(level.facility.ceilingOffset > 15, 'ceiling lifted ' + level.facility.ceilingOffset);
  assert.ok(level.structure.b1Offset < -13, 'subfab lowered ' + level.structure.b1Offset);
  assert.equal(level.environment.linksVisible, true, 'exploded interconnects visible');
  record('level-EXPLODED', { ceilingOffset: level.facility.ceilingOffset, b1Offset: level.structure.b1Offset });
  await clickId('level-btn-l1');
  // The source eases the hierarchy by 8% per frame and only settles below 0.0005; the
  // floor slab/ceiling offsets follow that eased factor, so wait for the settled state.
  await until('window.__SEMICONFAB_PERF__.getWorld().explodeFactor === 0 && window.__SEMICONFAB_PERF__.getWorld().level === "L1"', 'explode unwinds to settled L1', 30000);
  await sleep(250);
  level = await diag();
  assert.ok(near(level.structure.floorAlpha, 1, 0.01), 'L1 floor opacity');
  assert.equal(level.structure.b1Visible, false, 'L1 hides B1');
  assert.equal(level.structure.slabVisible, true, 'L1 slab visible');
  assert.ok(near(level.facility.ceilingOffset, 0, 0.01) && near(level.structure.b1Offset, 0, 0.01), 'offsets reset');
  record('level-L1', level.structure);

  // ---- C5: layer toggles ----
  await clickId('btn-toggle-roof'); await sleep(500);
  let layerState = await diag();
  assert.equal(layerState.environment.roofVisible, true, 'roof layer');
  assert.ok(layerState.environment.roofParticles > 0, 'roof exhaust particles exist');
  await clickId('btn-toggle-ceiling'); await sleep(400);
  layerState = await diag();
  assert.equal(layerState.facility.ceilingVisible, true, 'ceiling layer');
  await clickId('btn-toggle-piping'); await sleep(400);
  layerState = await diag();
  assert.equal(layerState.structure.b1Visible, true, 'subfab/piping layer');
  // Airflow (#btn-toggle-laminar) owns the whole aerodynamics mode; the heatmap toggle is a
  // sub-overlay of it (source semantics verified in this run).
  await clickId('btn-toggle-laminar'); await sleep(900);
  layerState = await diag();
  assert.equal(layerState.environment.airflowVisible, true, 'airflow layer');
  assert.equal(await evaluate('document.querySelector(".twin-page").dataset.spatialMode'), 'aerodynamics', 'airflow spatial mode');
  const airflowClockA = layerState.environment.airflowClock;
  await sleep(700);
  assert.ok((await diag()).environment.airflowClock > airflowClockA, 'airflow clock advances');
  await clickId('btn-toggle-heatmap'); await sleep(900);
  layerState = await diag();
  assert.equal(layerState.environment.heatmapVisible, true, 'heatmap layer');
  assert.ok(layerState.environment.heatmapUpdates > 0, 'heatmap texture updates');
  assert.equal(layerState.environment.airflowVisible, true, 'heatmap keeps the laminar layer');
  await clickId('btn-toggle-oht'); await sleep(400);
  assert.equal((await diag()).motion.amhsVisible, false, 'AMHS layer hides');
  await clickId('btn-toggle-oht');
  await clickId('btn-toggle-heatmap'); await sleep(300);
  await clickId('btn-toggle-laminar'); await sleep(300);
  await clickId('btn-toggle-piping'); await sleep(300);
  await clickId('btn-toggle-ceiling'); await sleep(300);
  await clickId('btn-toggle-roof'); await sleep(300);
  layerState = await diag();
  assert.equal(layerState.environment.roofVisible, false, 'roof restored');
  assert.equal(layerState.structure.b1Visible, false, 'piping restored');
  record('layers', true);

  // ---- C6: tool state sync (manual MAINT through the inspector) ----
  await clickId('level-btn-l1');
  await until('window.__SEMICONFAB_PERF__.getWorld().explodeFactor === 0', 'settled L1 for state sync', 30000);
  await sleep(500);
  // Select a real tool through the canvas again: sidebar reference rows that are not catalog
  // entries only clear the native selection (frozen product behaviour).
  let stateSelection = null;
  for (let index = 0; index < 121 && !stateSelection; index += 1) {
    const point = await evaluate('window.__SEMICONFAB_PERF__.projectTool(' + index + ')');
    if (!point || point.x < 430 || point.x > 1360 || point.y < 130 || point.y > 660) continue;
    await clickPoint(point.x, point.y);
    await sleep(260);
    const state = await diag();
    if (Number.isInteger(state.selection.index)) stateSelection = state;
  }
  assert.ok(stateSelection, 'canvas selection for the state-sync check');
  await until('!!document.querySelector(".twin-manual-state")', 'manual state controls', 8000);
  const indexForState = stateSelection.selection.index;
  assert.ok(Number.isInteger(indexForState), 'inspector selection exposes a tool index');
  await evaluate('(() => { const button = [...document.querySelectorAll(".twin-manual-state button")].find(item => item.textContent === "MAINT"); if (button) button.click(); })()');
  const waitState = async expected => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const states = (await diag()).toolStates;
      if (states[indexForState] === expected) return true;
      await sleep(120);
    }
    return false;
  };
  assert.ok(await waitState('maint'), 'manual MAINT reaches the native frame sync');
  await evaluate('(() => { const button = [...document.querySelectorAll(".twin-manual-state button")].find(item => item.textContent === "RUN"); if (button) button.click(); })()');
  await sleep(300);
  record('tool-state', 'maint');

  // ---- C7: X-Ray filters and material restore ----
  await clickId('btn-toggle-xray'); await sleep(600);
  let effectsState = await diag();
  assert.equal(effectsState.xray.filter, 'all', 'xray all');
  assert.ok(effectsState.xray.shaderMeshes > 0, 'xray hologram materials active');
  assert.equal(effectsState.structure.b1Visible, true, 'xray forces subfab visible');
  await clickId('xray-btn-vac'); await sleep(500);
  effectsState = await diag();
  assert.equal(effectsState.xray.filter, 'vac', 'xray vac filter');
  await clickId('btn-toggle-xray'); await sleep(600);
  effectsState = await diag();
  assert.equal(effectsState.xray.filter, null, 'xray restored');
  assert.equal(effectsState.xray.shaderMeshes, 0, 'hologram materials restored');
  assert.equal(effectsState.structure.b1Visible, false, 'L1 subfab restored after xray');
  record('xray-restore', true);

  // ---- C8: section cut on the whole scene ----
  await clickId('btn-toggle-cut');
  await until('!!document.querySelector(".twin-cut")', 'cut panel');
  await evaluate('(() => { const select = document.querySelector("#cut-axis-select"); select.value = "Z"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await setRange('#cut-slider', 12);
  await sleep(400);
  effectsState = await diag();
  assert.ok(vectorNear(effectsState.cutPlane, [0, 0, -1, -12], 0.001), 'cut plane Z +12: ' + JSON.stringify(effectsState.cutPlane));
  await clickId('btn-cut-invert'); await sleep(500);
  effectsState = await diag();
  // Source plane [0,0,-1,+12] reflected into Lite render space only on the Z normal.
  assert.ok(vectorNear(effectsState.cutPlane, [0, 0, 1, 12], 0.001), 'cut plane inverted: ' + JSON.stringify(effectsState.cutPlane));
  // Source spatial modes are exclusive: enabling X-Ray leaves cut mode and clears the plane.
  await clickId('btn-toggle-xray'); await sleep(600);
  effectsState = await diag();
  assert.equal(effectsState.xray.filter, 'all', 'xray after cut');
  assert.equal(effectsState.cutPlane, null, 'exclusive mode clears the cut plane');
  assert.equal(await evaluate('!!document.querySelector(".twin-cut")'), false, 'cut panel closes');
  await clickId('btn-toggle-xray'); await sleep(500);
  effectsState = await diag();
  assert.equal(effectsState.xray.filter, null, 'xray disabled');
  assert.equal(effectsState.cutPlane, null, 'cut disabled');
  record('cut', true);

  // ---- C9: wafer follow, tour, patrol, language ----
  await clickId('btn-follow-wafer');
  await until('window.__SEMICONFAB_PERF__.getDiagnostics().wafer.markerVisible === true', 'wafer marker visible', 10000);
  const waferStart = (await diag()).wafer;
  // The source trail only keeps visited route points, so it appears after the wafer has moved.
  await until('(() => { const wafer = window.__SEMICONFAB_PERF__.getDiagnostics().wafer; return wafer.trailVisible && wafer.trailIndexCount > 0; })()', 'wafer trail draws', 45000);
  const waferA = (await diag()).wafer;
  assert.ok(waferA.trailIndexCount > 0, 'wafer trail draws');
  await until('(() => { const wafer = window.__SEMICONFAB_PERF__.getDiagnostics().wafer; return Math.hypot(wafer.position[0] - ' + waferStart.position[0] + ', wafer.position[2] - ' + waferStart.position[2] + ') > 0.05; })()', 'wafer marker moves', 45000);
  const waferB = (await diag()).wafer;
  assert.ok(Math.hypot(waferB.position[0] - waferStart.position[0], waferB.position[2] - waferStart.position[2]) > 0.05, 'wafer marker moves');
  await clickId('wafer-cam-toggle-btn'); await sleep(600);
  const waferPose = await pose();
  assert.ok(Math.hypot(waferPose.target[0] - waferB.position[0], waferPose.target[2] - waferB.position[2]) < 5, 'wafer follow camera targets the marker');
  await clickSelector('.twin-wafer-head button');
  await sleep(400);
  assert.equal((await diag()).wafer.markerVisible, false, 'wafer marker hidden after close');
  record('wafer', { trailIndexCount: waferA.trailIndexCount });
  await clickId('btn-cinematic-tour');
  await until('!!document.querySelector(".twin-tour-card")', 'tour card', 8000);
  const tourSamples = [];
  for (let sample = 0; sample < 10; sample += 1) { tourSamples.push(await pose()); await sleep(300); }
  const distinct = new Set(tourSamples.map(value => value.position.map(component => component.toFixed(2)).join(',')));
  assert.ok(distinct.size > 2, 'tour animates the camera: ' + distinct.size);
  assert.ok(await evaluate('!!document.querySelector(".twin-tour-card")'), 'tour card open');
  await clickId('btn-cinematic-tour');
  await until('!document.querySelector(".twin-tour-card")', 'tour closed', 8000);
  const patrol = (await diag()).motion.patrol;
  await clickId('btn-focus-patrol'); await sleep(500);
  const patrolPose = await pose();
  assert.ok(Math.hypot(patrolPose.target[0] - patrol[0], patrolPose.target[2] - patrol[2]) < 2, 'patrol focus targets the walking engineer');
  record('tour-patrol', { distinct: distinct.size });
  await clickId('lang-toggle-btn');
  await until('document.documentElement.lang === "en-US"', 'english toggle');
  await clickId('lang-toggle-btn');
  await until('document.documentElement.lang === "zh-CN"', 'chinese toggle');
  record('language', true);

  // ---- D: three device losses preserve native + product state ----
  await clickId('level-btn-l1');
  await until('window.__SEMICONFAB_PERF__.getWorld().explodeFactor === 0', 'settled L1 before recovery', 30000);
  await clickId('btn-toggle-roof'); await sleep(400);
  const setCutMode = async () => {
    if (!(await evaluate('!!document.querySelector(".twin-cut")'))) await clickId('btn-toggle-cut');
    await until('!!document.querySelector(".twin-cut")', 'cut panel for recovery');
    await evaluate('(() => { const select = document.querySelector("#cut-axis-select"); select.value = "Z"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await setRange('#cut-slider', 12);
    await sleep(400);
  };
  const setXrayMode = async () => {
    if (!(await evaluate('window.__SEMICONFAB_PERF__.getDiagnostics().xray.filter !== null'))) await clickId('btn-toggle-xray');
    await until('window.__SEMICONFAB_PERF__.getDiagnostics().xray.filter === "all"', 'xray on for recovery');
    await sleep(300);
  };
  const cameraBeforeLoss = await pose();
  const recoveryRounds = [];
  const recoveryModes = ['cut', 'xray', 'none'];
  for (let round = 0; round < 3; round += 1) {
    const mode = recoveryModes[round];
    const expectXray = mode === 'xray';
    let expectedSelection = null;
    if (mode === 'xray') await setXrayMode();
    else if (mode === 'cut') await setCutMode();
    else {
      // Third round: no spatial mode, so the frozen source keeps the canvas selection -- the
      // restore path must bring it back on the replacement-device scene.
      if (await evaluate('window.__SEMICONFAB_PERF__.getDiagnostics().xray.filter !== null')) { await clickId('btn-toggle-xray'); await sleep(500); }
      if (await evaluate('!!document.querySelector(".twin-cut")')) { await clickId('btn-toggle-cut'); await sleep(500); }
      for (let index = 0; index < 121 && expectedSelection === null; index += 1) {
        const point = await evaluate('window.__SEMICONFAB_PERF__.projectTool(' + index + ')');
        if (!point || point.x < 430 || point.x > 1360 || point.y < 130 || point.y > 660) continue;
        await clickPoint(point.x, point.y);
        await sleep(300);
        const state = await diag();
        if (Number.isInteger(state.selection.index)) expectedSelection = state.selection.index;
      }
      assert.ok(Number.isInteger(expectedSelection), 'canvas selection before the no-mode loss round');
    }
    const lossesBefore = (await lifecycle()).losses;
    const preLoss = await diag();
    const preLossShaders = JSON.stringify(preLoss.shaderMaterials);
    await command('Page.bringToFront');
    await evaluate('window.__SEMICONFAB_PERF__.forceDeviceLoss()');
    await until('window.__SEMICONFAB_PERF__.getLifecycle().losses >= ' + (lossesBefore + 1), 'loss registered', 20000);
    const recoveryDeadline = Date.now() + 120000;
    while (Date.now() < recoveryDeadline) {
      const state = await evaluate('window.__SEMICONFAB_PERF__ ? JSON.stringify({ lifecycle: window.__SEMICONFAB_PERF__.getLifecycle(), status: document.querySelector(".twin-status")?.getAttribute("title") ?? null, gpu: window.__SEMICONFAB_PERF__.getDiagnostics()?.gpuErrors?.slice(0, 2) ?? [] }) : "perf-missing"');
      if (state !== 'perf-missing' && JSON.parse(state).lifecycle.lastStatus.startsWith('WebGPU')) break;
      await sleep(250);
      if (Date.now() >= recoveryDeadline) throw new Error('recovery stuck: ' + state + ' shaders=' + preLossShaders);
    }
    await sleep(800);
    const recovered = await diag();
    const recoveredLifecycle = await lifecycle();
    assert.equal(recoveredLifecycle.losses, lossesBefore + 1, 'loss count: before=' + lossesBefore + ' state=' + JSON.stringify(recoveredLifecycle));
    assert.ok(recoveredLifecycle.recoveries >= round + 1, 'recovery count');
    assert.deepEqual(recovered.gpuErrors, [], 'no GPU validation errors after loss');
    // Product strategy rebuilds the native scene on the replacement device (same backend/Redux
    // state); the bounded fixtures verify the in-place native recovery path separately.
    assert.ok(recoveredLifecycle.recoveries >= round + 1, 'scene rebuilt on the replacement device');
    if (mode === 'xray') {
      assert.equal(recovered.xray.filter, 'all', 'xray state restored');
      assert.ok(recovered.xray.shaderMeshes > 0, 'xray materials rebound');
    } else if (mode === 'cut') {
      assert.ok(recovered.cutPlane !== null, 'cut plane restored');
    } else {
      assert.equal(recovered.cutPlane, null, 'no cut mode in the no-mode round');
      assert.equal(recovered.xray.filter, null, 'no xray in the no-mode round');
      assert.equal(recovered.selection.index, expectedSelection, 'canvas selection preserved across recovery');
      assert.equal(recovered.selection.visible, true, 'selection wireframe restored');
    }
    assert.equal(recovered.environment.roofVisible, true, 'roof layer restored');
    assert.equal(recovered.toolStates.length, 121, 'all tool states present after recovery');
    assert.ok(recovered.toolStates.every(state => ['running', 'idle', 'down', 'maint'].includes(state)), 'valid tool states after recovery');
    assert.equal(recovered.meshCount, before.meshCount, 'mesh count preserved');
    recoveryRounds.push({ round, mode, losses: recoveredLifecycle.losses, recoveries: recoveredLifecycle.recoveries });
  }
  const poseAfterLoss = await pose();
  assert.ok(vectorNear(poseAfterLoss.position, cameraBeforeLoss.position, 3), 'camera pose preserved across losses');
  // The rebuilt native scene must still consume the Redux tool-state stream. Cut mode clears the
  // selection in the frozen source, so re-select a tool through the canvas after the recovery loop.
  let syncSelection = null;
  for (let index = 0; index < 121 && !syncSelection; index += 1) {
    const point = await evaluate('window.__SEMICONFAB_PERF__.projectTool(' + index + ')');
    if (!point || point.x < 430 || point.x > 1360 || point.y < 130 || point.y > 660) continue;
    await clickPoint(point.x, point.y);
    await sleep(260);
    const state = await diag();
    if (Number.isInteger(state.selection.index)) syncSelection = state;
  }
  assert.ok(syncSelection, 'canvas selection after recovery');
  const syncIndex = syncSelection.selection.index;
  await until('!!document.querySelector(".twin-manual-state")', 'inspector after recovery selection', 10000);
  await evaluate('(() => { const button = [...document.querySelectorAll(".twin-manual-state button")].find(item => item.textContent === "MAINT"); if (button) button.click(); })()');
  const resyncDeadline = Date.now() + 8000;
  let resynced = false;
  while (Date.now() < resyncDeadline) {
    if ((await diag()).toolStates[syncIndex] === 'maint') { resynced = true; break; }
    await sleep(150);
  }
  assert.ok(resynced, 'Redux tool-state sync resumes after recovery');
  record('recovery-x3', recoveryRounds);
  if (await evaluate('window.__SEMICONFAB_PERF__.getDiagnostics().xray.filter !== null')) await clickId('btn-toggle-xray');
  await sleep(300);
  if (await evaluate('!!document.querySelector(".twin-cut")')) await clickId('btn-toggle-cut');
  await sleep(300);
  await clickId('btn-toggle-roof');
  const final = await diag();
  assert.deepEqual(final.gpuErrors, [], 'no GPU errors in the whole acceptance run');
  result.diagnostics = { meshCount: final.meshCount, shadowCasters: final.shadowCasters, gpuErrors: final.gpuErrors.length };
  result.lifecycle = await lifecycle();
  result.finalStatus = await evaluate('document.querySelector(".twin-status").getAttribute("title")');
  assert.ok(result.finalStatus.startsWith('WebGPU ·'), 'final status');
  return result;
}
