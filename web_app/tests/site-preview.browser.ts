// @ts-nocheck — standalone CDP harness; page.evaluate payloads are untyped.
// Requires the local dev server and an isolated Chromium/Edge CDP port.
// Set CDP_PORT when the browser listens on a non-default port (default 9335).
// No browser automation dependency and no WebGPU hardware acceptance claim.
import assert from 'node:assert/strict';

const port = process.env.CDP_PORT ?? '9335';
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find((value) => value.type === 'page' && value.url.includes('5173'));
assert.ok(tab, 'No isolated workbench page');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown')
    runtimeErrors.push(message.params.exceptionDetails.text);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}
async function pressEscape() {
  await command('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
}

try {
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await until(`!!document.querySelector('.site-preview .icon-with-label')`);
  await until(`!!document.querySelector('.site-preview .scene canvas')`);

  const initial = await evaluate(`(() => {
    const panel = document.querySelector('.site-preview');
    return {
      label: panel.querySelector('.icon-with-label').getAttribute('aria-label'),
      backdrop: !!document.querySelector('.preview-backdrop'),
      fabOptions: panel.querySelectorAll('.fab-picker option').length,
      canvas: !!panel.querySelector('.scene canvas'),
    };
  })()`);
  assert.equal(initial.label, '在新标签页打开 FAB 预览');
  assert.equal(initial.backdrop, false);
  assert.equal(initial.fabOptions, 0);
  assert.equal(initial.canvas, true);

  const openedUrl = await evaluate(`(() => {
    let captured = '';
    const original = window.open;
    window.open = (url) => { captured = String(url); return null; };
    document.querySelector('.site-preview .icon-with-label').click();
    window.open = original;
    return captured;
  })()`);
  assert.match(openedUrl, /\/preview\?siteId=/);
  await command('Page.navigate', { url: openedUrl });
  await until(`!!document.querySelector('.standalone-preview')`);
  await until(`!!document.querySelector('.standalone-stage .scene canvas')`);
  await until(`document.querySelector('.scene-status')?.textContent?.startsWith('WebGPU ·')`);
  const opened = await evaluate(`(() => {
    const stage = document.querySelector('.standalone-stage');
    return {
      standalone: !!document.querySelector('.standalone-preview'),
      header: !!document.querySelector('.standalone-head'),
      width: stage.getBoundingClientRect().width,
      height: stage.getBoundingClientRect().height,
      viewport: window.innerWidth,
      backdrop: !!document.querySelector('.preview-backdrop'),
      dialog: !!document.querySelector('[role="dialog"]'),
      bodyOverflow: document.body.style.overflow,
      rail: !!document.querySelector('.scene-rail'),
      back: document.querySelector('.standalone-back')?.getAttribute('href'),
    };
  })()`);
  assert.equal(opened.standalone, true);
  assert.equal(opened.header, true);
  assert.ok(opened.width >= opened.viewport - 2, 'standalone stage should fill the viewport width');
  assert.ok(opened.height > 600, 'standalone stage should fill the viewport height');
  assert.equal(opened.backdrop, false);
  assert.equal(opened.dialog, false);
  assert.equal(opened.bodyOverflow, '');
  assert.equal(opened.rail, true);
  assert.equal(opened.back, '/');
  await until(`document.querySelector('.scene-status')?.textContent?.startsWith('WebGPU ·')`);
  await until(`!!document.querySelector('.scene-amhs-hud')`);
  assert.match(await evaluate(`document.querySelector('.scene-amhs-hud').innerText`), /AMHS[\s\S]*OHT[\s\S]*\d{2}\/24/);
  await until(`!!document.querySelector('.feed-pill')`);
  assert.match(await evaluate(`document.querySelector('.feed-pill').innerText`), /LIVE \d{2}:\d{2}:\d{2}/);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-zone-chip').length`), 10);
  assert.match(await evaluate(`document.querySelector('.scene-util').innerText`), /UTIL \d+\.\d%/);
  assert.equal(await evaluate(`!!document.querySelector('.scene-tour-toggle')`), true);
  assert.match(await evaluate(`document.querySelector('.scene-alarm').innerText`), /故障 \d+/);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-mode-chip').length`), 3);
  await evaluate(`document.querySelectorAll('.scene-mode-chip')[2].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-mode-chip')[2].getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelectorAll('.scene-mode-chip')[2].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-mode-chip')[2].getAttribute('aria-pressed')`), 'false');

  const layerStates = await evaluate(`Array.from(document.querySelectorAll('.scene-layer-toggle')).map((b) => b.getAttribute('aria-pressed'))`);
  assert.deepEqual(Array.from(layerStates), ['true', 'false', 'false', 'false', 'false', 'false']);
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[0].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[0].getAttribute('aria-pressed')`), 'false');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[0].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[0].getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[3].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[3].getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[3].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[3].getAttribute('aria-pressed')`), 'false');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[4].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[4].getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[4].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[4].getAttribute('aria-pressed')`), 'false');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[5].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[5].getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelectorAll('.scene-layer-toggle')[5].click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.scene-layer-toggle')[5].getAttribute('aria-pressed')`), 'false');

  assert.equal(await evaluate(`document.querySelectorAll('.scene-state-filter-item').length`), 5);
  const chosenState = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.scene-state-filter-item')].filter((item) => item.dataset.state === 'down' || item.dataset.state === 'idle');
    const item = items.find((entry) => Number(entry.querySelector('span').textContent) > 0) ?? items[0];
    const count = Number(item.querySelector('span').textContent);
    const label = item.innerText.split('\\n')[0];
    item.click();
    return { state: item.dataset.state, count, label };
  })()`);
  await until(`document.querySelectorAll('.scene-tool-list-item').length === ${chosenState.count}`);
  await evaluate(`document.querySelector('.scene-tool-list-item').click()`);
  await until(`!!document.querySelector('.scene-toolcard')`);
  assert.match(await evaluate(`document.querySelector('.scene-toolcard').innerText`), new RegExp(chosenState.label));
  await evaluate(`document.querySelector('.scene-toolcard button[aria-label="关闭设备详情"]').click()`);
  await until(`!document.querySelector('.scene-toolcard')`);
  await evaluate(`document.querySelector('.scene-state-filter-item[data-state="all"]').click()`);
  await until(`document.querySelectorAll('.scene-tool-list-item').length === 121`);

  assert.equal(await evaluate(`document.querySelectorAll('.scene-rail-select option').length`), 14);
  await evaluate(`(() => { const select = document.querySelector('.scene-rail-select'); select.value = 'lithography'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`document.querySelectorAll('.scene-tool-list-item').length === 8`);
  await evaluate(`(() => { const select = document.querySelector('.scene-rail-select'); select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`document.querySelectorAll('.scene-tool-list-item').length === 121`);

  await evaluate(`document.querySelector('.scene-tool-list-item').click()`);
  await until(`!!document.querySelector('.scene-toolcard')`);
  assert.match(await evaluate(`document.querySelector('.scene-toolcard').innerText`), /TWINSCAN NXT:2050i/);
  assert.equal(await evaluate(`document.querySelector('.scene-toolcard-focus')?.innerText`), '定位');
  await evaluate(`document.querySelector('.scene-toolcard button[aria-label="关闭设备详情"]').click()`);
  await until(`!document.querySelector('.scene-toolcard')`);

  const pickPoint = await evaluate(`(async () => {
    const entries = performance.getEntriesByType('resource');
    const entry = entries.findLast(r => r.name.includes('/@babylonjs_core_Engines_webgpuEngine.js')).name;
    const source = await (await fetch(entry)).text();
    const path = source.match(/import \\{[^}]* as EngineStore[^}]*\\} from "([^"]+)"/)[1];
    const store = Object.values(await import(new URL(path, entry).href)).find(value => typeof value === 'function' && 'LastCreatedScene' in value);
    const scene = store.LastCreatedScene, engine = scene.getEngine();
    const { Matrix, Vector3 } = await import(entries.findLast(r => r.name.includes('/@babylonjs_core_Maths_math__vector.js')).name);
    const mesh = scene.getMeshByName('original-tool-0-part-4');
    mesh.computeWorldMatrix(true);
    const p = Vector3.Project(mesh.getAbsolutePosition(), Matrix.IdentityReadOnly, scene.getTransformMatrix(), scene.activeCamera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    const r = document.querySelector('.scene canvas').getBoundingClientRect();
    return { x: r.left + p.x * r.width / engine.getRenderWidth(), y: r.top + p.y * r.height / engine.getRenderHeight() };
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pickPoint });
  await until(`!!document.querySelector('.scene-hovercard')`);
  assert.ok((await evaluate(`document.querySelector('.scene-hovercard').innerText`)).length > 0);
  const hoveredModel = await evaluate(`document.querySelector('.scene-hovercard span').textContent`);

  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...pickPoint, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pickPoint, button: 'left', clickCount: 1 });
  await until(`!!document.querySelector('.scene-toolcard')`);
  const picked = await evaluate(`document.querySelector('.scene-toolcard').innerText`);
  assert.ok(picked.includes(hoveredModel), 'click and hover must identify the same equipment at this viewport size');
  await evaluate(`document.querySelector('.scene-toolcard button[aria-label="关闭设备详情"]').click()`);
  await until(`!document.querySelector('.scene-toolcard')`);

  const pinch = await evaluate(`(() => {
    const rail = document.querySelector('.scene-rail');
    const canvas = document.querySelector('.scene canvas');
    const railEvent = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 40 });
    const canvasEvent = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -40 });
    rail.dispatchEvent(railEvent);
    canvas.dispatchEvent(canvasEvent);
    return {
      rail: railEvent.defaultPrevented,
      canvas: canvasEvent.defaultPrevented,
      touchAction: getComputedStyle(document.querySelector('.scene')).touchAction,
    };
  })()`);
  assert.equal(pinch.rail, true, 'pinch over viewer chrome must stay inside the preview');
  assert.equal(pinch.canvas, true, 'pinch over the scene must stay inside the preview');
  assert.equal(pinch.touchAction, 'none');

  const single = await evaluate(`(() => ({
    picker: !!document.querySelector('.fab-picker'),
    instances: document.querySelectorAll('.scene-rail-item').length,
    tag: document.querySelector('.scene-tag').textContent,
  }))()`);
  assert.equal(single.picker, false);
  assert.equal(single.instances, 0);
  assert.match(single.tag, /FAB-01/);

  await evaluate(`document.querySelector('.view-switch button[aria-label="俯视视图"]').click()`);
  await until(`document.querySelector('.view-switch button[aria-label="俯视视图"]').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('.view-switch button[aria-label="等轴视图"]').click()`);
  await until(`document.querySelector('.view-switch button[aria-label="等轴视图"]').getAttribute('aria-pressed') === 'true'`);

  assert.equal(await evaluate(`document.querySelector('.standalone-head .technical').innerText`), 'FAB PREVIEW');
  assert.match(await evaluate(`document.querySelector('.standalone-title strong').innerText`), /FAB-01/);
  assert.equal(await evaluate(`!!document.querySelector('.site-preview')`), false);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.scene')).touchAction`), 'none');

  assert.deepEqual(runtimeErrors, []);
  console.log('site preview browser acceptance passed');
} finally {
  socket.close();
}
