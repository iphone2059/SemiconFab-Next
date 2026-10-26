#!/usr/bin/env node
// Frozen-clock visual A/B between the native Lite /twin build and the frozen pre-migration Next
// reference build. Reproduces the comparison recorded in
// docs/migration/babylon-lite/evidence/product-completion-2026-10-26/README.md section 3 without any
// scratch scripts: both pages get the reference golden harness clock (fixed virtual frames, seeded
// Math.random, fixed Date.now) injected through CDP Page.addScriptToEvaluateOnNewDocument, are
// advanced only by __twinGoldenClock.step(n), and are captured at identical virtual frame counts.
//
// Usage:
//   node tools/frozen_visual_compare.mjs --ref http://127.0.0.1:5179 --lite http://127.0.0.1:5178 \
//     --port 9490 --out .local/frozen-visual
//
// Requires a Chromium CDP endpoint with a visible foreground window (hidden/occluded tabs suspend
// requestAnimationFrame and stall the native runtime) plus local API/preview servers for both pages.
// The PNG decoder mirrors web_app/tests/support/png.ts (8-bit RGB/RGBA, all filter types) so the
// comparison needs Node only.
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// Source: frozen reference worktree 0b35ca5 web_app/tests/twin-goldens.browser.ts GOLDEN_CLOCK.
export const GOLDEN_CLOCK = `(() => {
  let seed=20261024, now=0, nextId=1;
  const callbacks=new Map();
  Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  Date.now=()=>1792800000000;
  Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
  window.requestAnimationFrame=callback=>{const id=nextId++;callbacks.set(id,callback);return id};
  window.cancelAnimationFrame=id=>callbacks.delete(id);
  window.__twinGoldenClock={step:async(frames=1)=>{for(let i=0;i<frames;i++){now+=1000/60;const batch=[...callbacks.values()];callbacks.clear();for(const callback of batch)callback(now);await new Promise(resolve=>setTimeout(resolve,0))}},get timeMs(){return now}};
  localStorage.setItem('semiconfab_lang','zh-CN');
  localStorage.setItem('semicon_lang','zh');
  localStorage.setItem('semicon_twin_onboarding_dismissed','1');
})()`;

export const VIEWS = [
  { id: 'iso', steps: [['[aria-label="ISO"]', 120]] },
  { id: 'top', steps: [['[aria-label="Top"]', 150]] },
  { id: 'b1', steps: [['#level-btn-b1', 300]] },
  { id: 'dual', steps: [['#level-btn-dual', 300]] },
  { id: 'exploded', steps: [['#level-btn-l1', 200], ['#level-btn-exploded', 700]] },
  { id: 'cut', steps: [['#level-btn-l1', 700], ['#btn-toggle-cut', 150]] },
  { id: 'xray', steps: [['#btn-toggle-cut', 60], ['#btn-toggle-xray', 400]] },
];
export const ROI = { x0: 400, y0: 120, x1: 1500, y1: 680 };
const VIEW_POSES = {
  iso: { position: [38, 48, 58], target: [0, 0, 0] },
  top: { position: [0, 95, .1], target: [0, 0, 0] },
  b1: { position: [-15, -2, 34], target: [-15, -6, -5] },
  dual: { position: [0, 38, 62], target: [0, -3, 0] },
  exploded: { position: [55, 44, 72], target: [0, -4, 0] },
  cut: { position: [0, 52, 64], target: [0, 2, 0] },
  xray: { position: [0, 52, 64], target: [0, 2, 0] },
};
const SETTLE_FRAMES = 180;
// Both sites pad readiness to this frame count so the whole view schedule runs on identical frames.
// First ready needs ~130 frames on a cold GPU upload, so the budget is deliberately generous.
const READY_FRAMES = 400;

/** Equal clocks cannot establish camera, viewport or renderer readiness. Fail closed. */
export function validateCapture(capture, expectedPose) {
  if (!capture.status?.startsWith('WebGPU ·')) throw new Error('renderer is not ready');
  if (capture.viewport?.width !== 1536 || capture.viewport?.height !== 735 || capture.viewport?.dpr !== 1)
    throw new Error('capture viewport/DPR mismatch');
  const canvas = capture.canvas;
  if (!(canvas?.cssWidth > 768 && canvas?.cssHeight > 300)
    || Math.abs(canvas.width - Math.round(canvas.cssWidth * capture.viewport.dpr)) > 1
    || Math.abs(canvas.height - Math.round(canvas.cssHeight * capture.viewport.dpr)) > 1)
    throw new Error('canvas backing size/rectangle mismatch');
  for (const field of ['position', 'target']) {
    const actual = capture.pose?.[field];
    if (!Array.isArray(actual) || actual.length !== 3 || actual.some((value, index) =>
      !Number.isFinite(value) || Math.abs(value - expectedPose[field][index]) > .002))
      throw new Error('camera mismatch: ' + JSON.stringify(capture.pose));
  }
}

/** Reject uniform/empty scene output, sampling above the X-Ray panel and outside the sidebar/HUD. */
export function validateScenePixels(image, roi = { x0: 400, y0: 140, x1: 1500, y1: 560 }) {
  if (!(roi.x0 >= 0 && roi.y0 >= 0 && roi.x1 <= image.width && roi.y1 <= image.height
    && roi.x1 > roi.x0 && roi.y1 > roi.y0)) throw new Error('scene ROI is outside screenshot');
  const sums = [0, 0, 0], squares = [0, 0, 0]; let count = 0;
  for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
    const offset = (y * image.width + x) * image.channels;
    for (let channel = 0; channel < 3; channel++) {
      const value = image.data[offset + channel]; sums[channel] += value; squares[channel] += value * value;
    }
    count++;
  }
  const variance = Math.max(...sums.map((sum, channel) => squares[channel] / count - (sum / count) ** 2));
  if (!Number.isFinite(variance) || variance < 16) throw new Error('blank or uniform scene capture');
}

async function captureMetadata(site, viewId) {
  // Let the UI finish its queued state projection, without advancing the virtual clock.
  let metadata;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    metadata = await site.evaluate(`({status:document.querySelector('.twin-status')?.title,
      pose:window.__SEMICONFAB_PERF__?.getCameraPose(),
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      canvas:{width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height,
        cssWidth:document.querySelector('canvas')?.getBoundingClientRect().width,
        cssHeight:document.querySelector('canvas')?.getBoundingClientRect().height}})`);
    try { validateCapture(metadata, VIEW_POSES[viewId]); return metadata; }
    catch (error) { if (attempt === 9) throw error; }
    await sleep(100);
  }
}

/** Mirrors web_app/tests/support/png.ts; returns {width,height,channels,data}. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG signature mismatch');
  let offset = 8; let width = 0; let height = 0; let colorType = 0; let bitDepth = 0;
  const idat = [];
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

/** Mean absolute RGB channel difference and changed-pixel fraction (>24) inside the ROI. */
export function diffViews(refPng, litePng, roi = ROI) {
  const a = decodePng(refPng); const b = decodePng(litePng);
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  let total = 0, changed = 0, count = 0;
  for (let y = roi.y0; y < roi.y1; y += 1) {
    for (let x = roi.x0; x < roi.x1; x += 1) {
      const ai = (y * a.width + x) * a.channels;
      const bi = (y * b.width + x) * b.channels;
      let maximum = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(a.data[ai + channel] - b.data[bi + channel]);
        total += delta;
        if (delta > maximum) maximum = delta;
      }
      if (maximum > 24) changed += 1;
      count += 1;
    }
  }
  return { meanAbsChannel: Math.round((total / (3 * count)) * 1000) / 1000, changedFraction: Math.round((changed / count) * 1e5) / 1e5 };
}

function parseArgs(argv) {
  const args = { ref: 'http://127.0.0.1:5179', lite: 'http://127.0.0.1:5178', port: '9490', out: '.local/frozen-visual' };
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    if (!(key in args)) throw new Error('unknown argument ' + argv[index]);
    args[key] = argv[index + 1];
  }
  return args;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Opens one page with the frozen clock, waits for the app shell to load without advancing the clock,
 * then drives frames until `WebGPU ·` becomes ready. The clock starts at 0 on both sides and is only
 * advanced after load, so both apps mount at the same virtual frame; `steps` records how many frames
 * each side needed so the caller can align both to an identical total before capturing.
 */
async function openSite(port, baseUrl, tag, transport, clockInHtml = false) {
  let close = async () => {};
  let command = transport;
  const errors = [];
  if (!command) {
  const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(value => value.value ?? value.description).join(' '));
    const handler = pending.get(message.id); if (!handler) return;
    pending.delete(message.id);
    message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
  });
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 180000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  close = async () => {
    socket.close();
    await fetch('http://127.0.0.1:' + port + '/json/close/' + tab.id).catch(() => {});
  };
  }
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  let steps = 0;
  const step = async frames => { steps += frames; return evaluate('window.__twinGoldenClock.step(' + frames + ')'); };
  await command('Page.enable'); await command('Runtime.enable'); await command('Log.enable');
  if (!clockInHtml) await command('Page.addScriptToEvaluateOnNewDocument', { source: GOLDEN_CLOCK });
  await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1536, height: 735, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' + (clockInHtml ? '&parity=1' : '') });
  const loadDeadline = Date.now() + 180000;
  let loaded = false;
  while (Date.now() < loadDeadline) {
    loaded = await evaluate('document.readyState === "complete" && !!document.querySelector(".twin-status")').catch(() => false);
    if (loaded) break;
    await sleep(100);
  }
  if (!loaded) throw new Error('page shell did not load: ' + tag);
  const readyDeadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    await step(1);
    ready = await evaluate('document.querySelector(".twin-status")?.getAttribute("title")?.startsWith("WebGPU ·") ?? false').catch(() => false);
    if (ready) break;
  }
  if (!ready) throw new Error('frozen-clock page did not become ready: ' + tag);
  await evaluate('document.fonts.ready');
  const click = async selector => {
    await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    // Redux/React projects the click asynchronously. Flush its first frame and queued effects
    // before consuming the fixed animation budget; otherwise the transition starts mid-budget.
    await step(1);
    await sleep(100);
  };
  const capture = async file => {
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    validateScenePixels(decodePng(png));
    fs.writeFileSync(file, png);
  };
  return { tag, steps: () => steps, step, click, capture, close, errors, evaluate };
}

/**
 * Runs one site end-to-end with a deterministic frame schedule: the clock starts at 0, frames only
 * advance after the shell has loaded, readiness then consumes a fixed budget of READY_FRAMES frames
 * (both sites pad to the same total), followed by SETTLE_FRAMES and identical per-view frames. Sites
 * are captured one at a time so a second tab can never occlude/blank the captured canvas.
 */
async function runSite(port, baseUrl, tag, outDir, command, clockInHtml) {
  const site = await openSite(port, baseUrl, tag, command, clockInHtml);
  try {
    if (site.steps() > READY_FRAMES) throw new Error(tag + ' needed ' + site.steps() + ' frames to become ready (budget ' + READY_FRAMES + ')');
    await site.step(READY_FRAMES - site.steps());
    await site.step(SETTLE_FRAMES);
    const files = {}; const times = {}; const captures = {};
    for (const view of VIEWS) {
      for (const [selector, frames] of view.steps) { await site.click(selector); await site.step(frames); }
      captures[view.id] = await captureMetadata(site, view.id);
      const file = path.join(outDir, tag + '-' + view.id + '.png');
      await site.capture(file);
      files[view.id] = file;
      times[view.id] = await site.evaluate('window.__twinGoldenClock.timeMs');
    }
    return { files, times, captures, errors: site.errors, totalFrames: site.steps() };
  } finally {
    await site.close();
  }
}

/** Capture through an existing supported tab transport; the caller owns the tab and error events. */
export async function captureFrozenSite(command, baseUrl, tag, outDir, { clockInHtml = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  return runSite(null, baseUrl, tag, outDir, command, clockInHtml);
}

/** Incremental capture for connected transports with bounded per-call execution times. */
export async function beginFrozenCapture(command, baseUrl, tag) {
  const site = await openSite(null, baseUrl, tag, command, true);
  if (site.steps() > READY_FRAMES) throw new Error(tag + ': readiness frame budget exceeded');
  await site.step(READY_FRAMES - site.steps());
  await site.step(SETTLE_FRAMES);
  return site;
}

export async function captureFrozenView(site, viewId, outDir) {
  const view = VIEWS.find(item => item.id === viewId);
  if (!view) throw new Error('unknown view: ' + viewId);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [selector, frames] of view.steps) { await site.click(selector); await site.step(frames); }
  const metadata = await captureMetadata(site, view.id);
  const file = path.join(outDir, site.tag + '-' + view.id + '.png');
  await site.capture(file);
  return { file, metadata, timeMs: await site.evaluate('window.__twinGoldenClock.timeMs'), totalFrames: site.steps() };
}

async function main() {
const args = parseArgs(process.argv);
fs.mkdirSync(args.out, { recursive: true });
// Sequential: a single foreground tab at a time, both sites on the identical virtual-frame schedule.
const reference = await runSite(args.port, args.ref, 'ref', args.out);
const lite = await runSite(args.port, args.lite, 'lite', args.out);
const views = {};
for (const view of VIEWS) views[view.id] = diffViews(fs.readFileSync(reference.files[view.id]), fs.readFileSync(lite.files[view.id]));
const report = {
  capturedAt: new Date().toISOString(),
  method: 'GOLDEN_CLOCK manual stepping via CDP Page.addScriptToEvaluateOnNewDocument; clock held at 0 until the shell loads, readiness padded to a fixed ' + READY_FRAMES + '-frame budget on both sites, +180 settle frames, identical per-view frame counts; one foreground tab captured at a time; viewport 1536x735 DPR1; ROI [400,120,1500,680]; absolute RGB diff computed in Node.',
  reference: { url: args.ref, commit: '0b35ca5' },
  lite: { url: args.lite },
  roi: ROI,
  views,
  timing: { referenceFrames: reference.totalFrames, liteFrames: lite.totalFrames, reference: reference.times, lite: lite.times },
  captures: { reference: reference.captures, lite: lite.captures },
  errors: { reference: reference.errors.length, lite: lite.errors.length },
};
fs.writeFileSync(path.join(args.out, 'frozen-clock-diff.json'), JSON.stringify(report, null, 2) + '\n');
if (reference.errors.length || lite.errors.length) throw new Error('console errors: ref=' + reference.errors.length + ' lite=' + lite.errors.length);
console.log(JSON.stringify(report, null, 2));
}

if (typeof process !== 'undefined' && process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
