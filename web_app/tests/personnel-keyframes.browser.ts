// @ts-nocheck — executable CDP acceptance, using a supplied browser transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ARTIFACT_DIR = 'C:/Users/han_qingyu/SemiconFab-Next/.local';

const PAGE_SETUP = `(async () => {
  const deadline = performance.now() + 30000;
  while (!window.__SEMICONFAB_PERF__?.getScene || !window.__SEMICONFAB_PERF__.getScene()?.metadata?.personnelTimeline) {
    if (performance.now() > deadline) throw new Error('perf diagnostics not available');
    await new Promise(requestAnimationFrame);
  }
  const perf = window.__SEMICONFAB_PERF__;
  while (!perf.getShadow()?.readyForCurrentDevice || !perf.getScene()?.metadata?.personnelTimeline) {
    if (performance.now() > deadline) throw new Error('personnel scene did not become ready');
    await new Promise(requestAnimationFrame);
  }
  const scene = perf.getScene();
  const engine = perf.getEngine();
  const timeline = scene.metadata.personnelTimeline;
  const errors = [];
  const onError = event => errors.push(event.error.message);
  engine._device.addEventListener('uncapturederror', onError);
  const frames = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
  const shortName = id => id.endsWith('main.1') ? 'main' : 'litho';
  const hex = color => parseInt(color.toHexString().slice(1, 7), 16);
  const sample = () => {
    const frame = timeline.readFrame();
    const actors = [0, 1, 2, 3, 4, 5].map(index => {
      const group = scene.getTransformNodeByName('operator-' + index);
      const leftLeg = scene.getTransformNodeByName('operator-leg-pivot-left-' + index);
      const rightLeg = scene.getTransformNodeByName('operator-leg-pivot-right-' + index);
      const leftArm = scene.getTransformNodeByName('operator-arm-pivot-left-' + index);
      const rightArm = scene.getTransformNodeByName('operator-arm-pivot-right-' + index);
      return {
        position: group ? { x: group.position.x, y: group.position.y, z: group.position.z, rotY: group.rotation.y } : null,
        legs: leftLeg && rightLeg ? [leftLeg.rotation.x, rightLeg.rotation.x] : null,
        arms: leftArm && rightArm ? [leftArm.rotation.x, rightArm.rotation.x] : null,
      };
    });
    const screen = scene.getMaterialByName('procedural-patrol-screen');
    const billboard = scene.getMeshByName('original-patrol-status');
    const chambers = frame.airShowers.map(shower => {
      const short = shortName(shower.id);
      const indicators = scene.materials.filter(material => String(material.name).startsWith('original-airshower-' + short + '-indicator-'));
      const jets = scene.materials.filter(material => String(material.name).startsWith('original-airshower-' + short + '-jet-'));
      const jetMeshes = scene.meshes.filter(mesh => mesh.name.startsWith('original-airshower-' + short + '-jet-'));
      const innerLight = scene.getLightByName('original-airshower-' + short + '-light');
      const chamberBillboard = scene.getMeshByName('original-airshower-' + short + '-billboard');
      return {
        id: shower.id,
        indicators: indicators.map(material => ({ color: hex(material.albedoColor), intensity: material.emissiveIntensity })),
        jets: jets.map(material => material.alpha),
        jetScales: jetMeshes.map(mesh => mesh.scaling.x),
        innerLight: innerLight ? innerLight.intensity : null,
        billboardY: chamberBillboard ? chamberBillboard.position.y : null,
      };
    });
    return {
      tick: frame.tick, time: frame.time,
      actors: frame.actors,
      patrol: {
        phase: frame.patrol.phase, stateTimer: frame.patrol.stateTimer, waypointIndex: frame.patrol.waypointIndex,
        legs: frame.patrol.legs, arms: frame.patrol.arms,
        screenColor: frame.patrol.screenColor, screenEmissive: frame.patrol.screenEmissive,
        screenEmissiveIntensity: frame.patrol.screenEmissiveIntensity, statusSpriteY: frame.patrol.statusSpriteY,
      },
      airShowers: frame.airShowers.map(shower => ({
        id: shower.id, isPurging: shower.isPurging, cycleBlowing: shower.cycleBlowing,
        indicatorColor: shower.indicator.color, indicatorIntensity: shower.indicator.intensity,
        jets: shower.jets, innerLight: shower.innerLight, labelSpriteY: shower.labelSpriteY,
      })),
      page: {
        actors,
        screen: screen ? { diffuse: hex(screen.diffuseColor), emissive: [screen.emissiveColor.r, screen.emissiveColor.g, screen.emissiveColor.b] } : null,
        billboard: billboard ? { exists: true, y: billboard.position.y, parent: billboard.parent?.name ?? null, enabled: billboard.isEnabled() } : { exists: false },
        chambers,
      },
      deviceErrors: errors.length,
    };
  };
  window.__personnelAcceptance = { scene, engine, timeline, frames, sample, dispose() { engine._device.removeEventListener('uncapturederror', onError); } };
})()`;

export async function runPersonnelKeyframeAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
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
  const shot = async name => {
    const capture = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(ARTIFACT_DIR + '/' + name, Buffer.from(capture.data, 'base64'));
  };
  const close = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
  const channels = color => [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  let mismatches = 0;
  const mismatchDetail = [];

  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  await until("!!document.querySelector('.twin-page')");
  await evaluate("localStorage.setItem('semicon_twin_onboarding_dismissed','1')");
  await command('Page.reload', { ignoreCache: false });
  await until("!!document.querySelector('.twin-page')");
  await until("document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')", 60000);
  await evaluate(PAGE_SETUP);
  await evaluate('__personnelAcceptance.frames(6)');

  const seenPhases = [];
  const screenshots = {};
  let samples = 0;
  let jetMax = 0;
  const required = ['ENTER_AIRLOCK', 'AIR_SHOWER_CYCLE', 'EXIT_TO_LITHO', 'PATROL_WAYPOINTS'];
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const sample = await evaluate('__personnelAcceptance.sample()');
    samples += 1;
    const fail = (category, detail) => { mismatches += 1; if (mismatchDetail.length < 12) mismatchDetail.push(category + ': ' + detail); };
    for (let index = 0; index < sample.actors.length; index += 1) {
      const expected = sample.actors[index];
      const actual = sample.page.actors[index];
      if (!actual) { fail('actor-missing', String(index)); continue; }
      if (!close(actual.position.x, expected.x) || !close(actual.position.y, expected.y) || !close(actual.position.z, expected.z)) fail('actor-position', index + ' expected ' + expected.x + ',' + expected.y + ',' + expected.z + ' got ' + actual.position.x + ',' + actual.position.y + ',' + actual.position.z);
      if (!close(actual.position.rotY, expected.rotY)) fail('actor-rotation', index);
      if (index === 5) {
        if (!close(actual.legs[0], sample.patrol.legs.left) || !close(actual.legs[1], sample.patrol.legs.right)) fail('patrol-legs', JSON.stringify(actual.legs));
        if (!close(actual.arms[0], sample.patrol.arms.left) || !close(actual.arms[1], sample.patrol.arms.right)) fail('patrol-arms', JSON.stringify(actual.arms));
        if (!sample.page.screen) fail('patrol-screen-missing', '');
        else {
          const expectedDiffuse = channels(sample.patrol.screenColor);
          const actualDiffuse = channels(sample.page.screen.diffuse);
          for (let channel = 0; channel < 3; channel += 1) if (!close(actualDiffuse[channel], expectedDiffuse[channel], 1)) fail('screen-diffuse', channel);
          const expectedEmissive = channels(sample.patrol.screenEmissive);
          for (let channel = 0; channel < 3; channel += 1) {
            if (!close(sample.page.screen.emissive[channel] * 255, expectedEmissive[channel] * sample.patrol.screenEmissiveIntensity, 2)) fail('screen-emissive', channel);
          }
        }
        if (!sample.page.billboard.exists || !sample.page.billboard.enabled || sample.page.billboard.parent !== 'operator-5') fail('patrol-billboard', JSON.stringify(sample.page.billboard));
      }
    }
    for (const chamber of sample.page.chambers) {
      const expected = sample.airShowers.find(value => value.id === chamber.id);
      if (!expected) { fail('airshower-frame-missing', chamber.id); continue; }
      if (chamber.indicators.length !== 2) fail('airshower-indicators', chamber.indicators.length);
      const expectedColor = channels(expected.indicatorColor);
      for (const indicator of chamber.indicators) {
        const actualColor = channels(indicator.color);
        for (let channel = 0; channel < 3; channel += 1) if (!close(actualColor[channel], expectedColor[channel], 1)) fail('indicator-color', chamber.id + ' channel ' + channel);
        if (!close(indicator.intensity, expected.indicatorIntensity, 0.01)) fail('indicator-intensity', chamber.id);
      }
      if (chamber.jets.length !== expected.jets.length) fail('jet-count', chamber.id + ' ' + chamber.jets.length + '/' + expected.jets.length);
      for (let index = 0; index < Math.min(chamber.jets.length, expected.jets.length); index += 1) {
        if (!Number.isFinite(chamber.jets[index]) || !close(chamber.jets[index], expected.jets[index].opacity, 0.01)) fail('jet-opacity', chamber.id + '[' + index + '] ' + chamber.jets[index] + '/' + expected.jets[index].opacity);
        if (!Number.isFinite(chamber.jetScales[index]) || !close(chamber.jetScales[index], expected.jets[index].scale, 0.01)) fail('jet-scale', chamber.id + '[' + index + ']');
        if (Number.isFinite(expected.jets[index].opacity)) jetMax = Math.max(jetMax, expected.jets[index].opacity);
      }
      if (chamber.innerLight !== null && !close(chamber.innerLight, expected.innerLight, 0.01)) fail('inner-light', chamber.id);
      if (chamber.billboardY !== null && !close(chamber.billboardY, expected.labelSpriteY, 0.01)) fail('airshower-billboard-y', chamber.id);
    }
    const phase = sample.patrol.phase;
    if (!seenPhases.includes(phase)) {
      seenPhases.push(phase);
      const names = {
        APPROACH_AIRLOCK: 'personnel-keyframe-approach.png',
        ENTER_AIRLOCK: 'personnel-keyframe-airlock-enter.png',
        AIR_SHOWER_CYCLE: 'personnel-keyframe-purge.png',
        EXIT_TO_LITHO: 'personnel-keyframe-airlock-exit.png',
        PATROL_WAYPOINTS: 'personnel-keyframe-patrol.png',
      };
      if (names[phase]) { screenshots[phase] = names[phase]; await shot(names[phase]); }
    }
    const mainBlowing = sample.airShowers.find(value => value.id === 'fac.airshower.main.1')?.cycleBlowing === true;
    if (mainBlowing && !screenshots.AIR_SHOWER_BLOW) {
      screenshots.AIR_SHOWER_BLOW = 'personnel-keyframe-airshower-blow.png';
      await shot('personnel-keyframe-airshower-blow.png');
    }
    if (required.every(value => seenPhases.includes(value))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(mismatches, 0, 'renderer must apply the source personnel frame exactly: ' + mismatchDetail.join(' | '));
  // Frozen as-built bug: buildCleanroomPersonnel overwrites userData, so air-shower jet/timer
  // updates are dead in the original runtime as well (the preserved timeline mode is opt-in and
  // not used by the product yet). The page must mirror the frame exactly either way; jetMax records
  // the actual as-built visibility instead of inventing a purge animation the source never shows.
  assert.deepEqual(required.filter(value => !seenPhases.includes(value)), [], 'required patrol phase transitions observed');
  for (const phase of required) assert.ok(screenshots[phase], 'missing keyframe for ' + phase);
  assert.equal(await evaluate('__personnelAcceptance.sample().deviceErrors'), 0);
  await evaluate('__personnelAcceptance.dispose()');
  return { samples, phases: seenPhases, screenshots, mismatches, jetMax };
}
