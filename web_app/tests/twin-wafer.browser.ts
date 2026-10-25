// @ts-nocheck — production CDP acceptance; the virtual RAF clock is test-only.
import assert from 'node:assert/strict';
import { GOLDEN_CLOCK, goldenEvaluate, waitForGoldenReady } from './twin-goldens.browser.ts';

export async function runWaferAcceptance(command, baseUrl = 'http://127.0.0.1:4173') {
  const evaluate = expression => goldenEvaluate(command, expression);
  const injection = await command('Page.addScriptToEvaluateOnNewDocument', { source: GOLDEN_CLOCK });
  try {
    await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
    await waitForGoldenReady(command, 'next');
    await evaluate(`(() => {
      const perf = window.__SEMICONFAB_PERF__, scene = perf.getScene();
      const errors = []; perf.getEngine()._device.addEventListener('uncapturederror', e => errors.push(e.error.message));
      window.__waferErrors = errors;
      window.__readWafer = () => {
        const marker = scene.getMeshByName('wafer-follow-marker');
        const trail = scene.getMeshByName('wafer-follow-trail');
        return { step: document.querySelector('#wafer-step-readout')?.textContent,
          status: document.querySelector('#wafer-status-readout')?.textContent,
          badge: document.querySelector('#wafer-route-badge')?.textContent,
          width: document.querySelector('#wafer-progress-bar')?.style.width,
          replay: !!document.querySelector('#wafer-replay-btn:not([hidden])'),
          position: marker.position.asArray(), rotation: marker.rotation.y,
          visible: marker.isEnabled() && marker.isVisible,
          trailId: trail?.uniqueId,
          camera: perf.getCameraPose(),
          trail: trail?.isEnabled() ? Array.from(trail.getVerticesData('position')).slice(0, (trail.subMeshes[0].indexCount / 2 + 1) * 3) : [],
          meshCount: scene.meshes.length };
      };
      document.querySelector('#btn-follow-wafer').click();
    })()`);
    // Wait for the route request with virtual frames; no seek/capture hooks in product.
    for (let i = 0; i < 200; i++) {
      if (await evaluate("!!document.querySelector('#wafer-step-readout')")) break;
      await evaluate('__twinGoldenClock.step(1)');
    }
    const start = await evaluate('__readWafer()');
    assert.match(start.status ?? '', /晶圆流转中/, 'opening starts playback with source HUD');
    assert.equal(await evaluate("document.querySelectorAll('#wafer-play-btn svg rect').length"), 2, 'playing shows the source pause icon');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#wafer-step-readout')).fontSize"), '12px', 'frozen computed typography includes its global 12px floor');
    assert.equal(await evaluate("document.querySelector('#wafer-follow-panel').getBoundingClientRect().width"), 448, 'source panel width at desktop');
    assert.ok(await evaluate("document.querySelector('#wafer-speed-16').getBoundingClientRect().height < 21"), 'source speed buttons have no global 24px minimum');
    assert.equal(start.visible, true, 'FOUP body must actually render');
    assert.equal(await evaluate("document.querySelectorAll('#wafer-follow-panel input[type=range]').length"), 0, 'no source seek control');
    await evaluate('__twinGoldenClock.step(150)');
    const transit = await evaluate('__readWafer()');
    assert.match(transit.step, /步骤 2\/120/);
    assert.ok(transit.trail.length >= 6 && transit.trail.length <= 90, '2..30 source trail points');
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(transit.camera.position[i] - transit.position[i] - [0, 6, -8][i]) < 1e-4, 'source camera offset');
    await evaluate("document.querySelector('#wafer-play-btn').click();__twinGoldenClock.step(1)");
    const paused = await evaluate('__readWafer()');
    await evaluate('__twinGoldenClock.step(40)');
    const still = await evaluate('__readWafer()');
    assert.deepEqual(still.position, paused.position, 'pause retains interpolated FOUP pose');
    assert.deepEqual(still.trail, paused.trail, 'pause retains trail');
    assert.match(still.status, /已暂停/);
    await evaluate("document.querySelector('#wafer-cam-toggle-btn').click(); document.querySelector('button[aria-label=Top]').click();__twinGoldenClock.step(90)");
    const free = await evaluate('__readWafer()');
    await evaluate("document.querySelector('#wafer-play-btn').click();__twinGoldenClock.step(30)");
    const movingFree = await evaluate('__readWafer()');
    assert.deepEqual(movingFree.camera, free.camera, 'free camera stays independent');
    await evaluate(`(() => { const select = document.querySelector('#wafer-product-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'C');select.dispatchEvent(new Event('change',{bubbles:true})); })();__twinGoldenClock.step(1)`);
    const product = await evaluate('__readWafer()');
    assert.equal(product.badge, 'Product C · 92 Steps');
    assert.match(product.step, /步骤 1\/92/);
    assert.match(product.status, /晶圆流转中/);
    assert.equal(product.replay, false);
    await evaluate("document.querySelector('#wafer-speed-16').click();__twinGoldenClock.step(800)");
    const complete = await evaluate('__readWafer()');
    assert.equal(complete.status, '路线完成');
    assert.equal(complete.width, '100%');
    assert.equal(complete.replay, true);
    assert.ok(complete.trail.length <= 90);
    assert.equal(complete.trailId, transit.trailId, 'trail reuses one GPU mesh through playback');
    await evaluate("document.querySelector('#wafer-replay-btn').click();__twinGoldenClock.step(1)");
    const replay = await evaluate('__readWafer()');
    assert.match(replay.step, /步骤 1\/92/);
    assert.equal(replay.replay, false);
    await evaluate("document.querySelector('#btn-cinematic-tour').click();__twinGoldenClock.step(3)");
    assert.equal(await evaluate("!!document.querySelector('#wafer-follow-panel')"), false, 'Tour excludes Wafer');
    assert.equal((await evaluate('__readWafer()')).visible, false);
    assert.deepEqual(await evaluate('__waferErrors'), []);
    return { start, transit, paused, product, complete, replay, deviceErrors: 0 };
  } finally { await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier }); }
}
