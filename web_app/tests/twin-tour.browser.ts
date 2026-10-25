// @ts-nocheck — executable CDP acceptance, using a supplied browser transport.
import assert from 'node:assert/strict';

const PAGE_SETUP = "(async () => {\n  const deadline = performance.now() + 30000;\n  while (!window.__SEMICONFAB_PERF__?.getCameraPose) {\n    if (performance.now() > deadline) throw new Error('tour diagnostics not available');\n    await new Promise(requestAnimationFrame);\n  }\n  const engine = window.__SEMICONFAB_PERF__.getEngine();\n  const errors = [];\n  const onError = event => errors.push(event.error.message);\n  engine._device.addEventListener('uncapturederror', onError);\n  const read = () => {\n    const tag = document.querySelector('#tour-hud-tag')?.textContent ?? null;\n    const timer = document.querySelector('#tour-hud-timer')?.textContent ?? null;\n    const width = document.querySelector('#tour-progress-bar i')?.style.width ?? null;\n    const camera = window.__SEMICONFAB_PERF__.getCameraPose();\n    const dots = [...document.querySelectorAll('#tour-dots-container button')].map(dot => dot.className.includes('active'));\n    return { at: performance.now(), tag, timer, width, camera, dots, active: tag !== null };\n  };\n  window.__tourAcceptance = {\n    read,\n    recordTour: (ms) => new Promise(resolve => {\n      const samples = [];\n      document.querySelector('#btn-cinematic-tour').click();\n      const timer = setInterval(() => samples.push(read()), 100);\n      setTimeout(() => { clearInterval(timer); resolve(samples); }, ms);\n    }),\n    errors: () => errors.length,\n    dispose: () => engine._device.removeEventListener('uncapturederror', onError),\n  };\n})()";

export async function runTourAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw new Error('Browser condition timed out: ' + expression);
  };

  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  await until("!!document.querySelector('.twin-page')");
  await evaluate("localStorage.setItem('semicon_twin_onboarding_dismissed','1')");
  await command('Page.reload', { ignoreCache: false });
  await until("!!document.querySelector('.twin-page')");
  await until("document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')", 60000);
  await evaluate(PAGE_SETUP);

  // One evaluate records the whole first waypoint + auto-advance window inside the page,
  // avoiding a CDP round-trip per sample while SwiftShader renders the tour.
  const samples = await evaluate('window.__tourAcceptance.recordTour(9600)');
  assert.ok(Array.isArray(samples) && samples.length > 40, 'tour must produce samples');
  const first = samples[0];
  assert.ok(first.active, 'tour HUD must open');
  assert.match(first.tag, /WAYPOINT 1\/5/, 'first waypoint tag');
  assert.match(first.timer, /^\d+s$/, 'source countdown text');
  const firstTween = samples.find(sample => sample.camera && Math.abs(sample.camera.position[0] - 70) < 1.5 && Math.abs(sample.camera.position[1] - 50) < 1.5 && Math.abs(sample.camera.position[2] - 75) < 1.5);
  assert.ok(firstTween, 'camera reaches frozen waypoint 1 pose');
  assert.ok(firstTween.camera.target.every(value => Math.abs(value) < 0.5), 'waypoint 1 lookAt');
  const advance = samples.find(sample => sample.tag?.includes('WAYPOINT 2/5'));
  assert.ok(advance, 'auto-advance to waypoint 2');
  const advanceAt = advance.at - samples[0].at;
  assert.ok(advanceAt >= 6500 && advanceAt <= 9000, 'auto-advance after frozen 2.2s tween + 5s hold, got ' + advanceAt);
  const afterAdvance = samples.filter(sample => sample.at > advance.at + 2200);
  const secondPose = afterAdvance.find(sample => sample.camera && Math.abs(sample.camera.position[0] + 20) < 2 && Math.abs(sample.camera.position[1] - 3.8) < 2 && Math.abs(sample.camera.position[2] - 12) < 2);
  assert.ok(secondPose, 'camera reaches frozen waypoint 2 pose');
  const timers = new Set(samples.map(sample => sample.timer));
  assert.ok(timers.size > 1, 'countdown must change');
  const widths = new Set(samples.map(sample => sample.width));
  assert.ok(widths.size > 2, 'progress bar must shrink over time');
  assert.ok(samples.some(sample => sample.dots && sample.dots.filter(Boolean).length === 1), 'one active source dot');

  // Frozen dots are display-only (the source only recolours them).
  const beforeDot = await evaluate("document.querySelectorAll('#tour-dots-container button')[4].click(); document.querySelector('#tour-hud-tag').textContent");
  await new Promise(resolve => setTimeout(resolve, 600));
  const afterDot = await evaluate("document.querySelector('#tour-hud-tag').textContent");
  assert.equal(afterDot, beforeDot, 'source tour dots must not jump waypoints');

  await evaluate("[...document.querySelectorAll('.twin-tour-actions button')][1].click()");
  await until("document.querySelector('#tour-hud-tag').textContent.includes('WAYPOINT 3/5')", 4000);
  await evaluate("[...document.querySelectorAll('.twin-tour-actions button')][0].click()");
  await until("document.querySelector('#tour-hud-tag').textContent.includes('WAYPOINT 2/5')", 4000);

  await evaluate("document.querySelector('#btn-cinematic-tour').click()");
  await until("!document.querySelector('#tour-hud-tag')", 4000);
  assert.equal(await evaluate('window.__tourAcceptance.errors()'), 0);
  await evaluate('window.__tourAcceptance.dispose()');
  return { samples: samples.length, advanceAt, firstTag: first.tag, firstTimer: first.timer, timers: [...timers], widths: [...widths].slice(0, 6) };
}
