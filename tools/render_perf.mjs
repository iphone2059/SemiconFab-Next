#!/usr/bin/env node
/**
 * Real-browser WebGPU/render performance gate (headless Chrome, localhost secure context).
 *
 * Usage (start scripts/start-dev.ps1 first so API + Vite are running):
 *   node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/FAB-01/3d
 *   node tools/render_perf.mjs --url ... --profile 60hz
 *
 * Measures actual renderer frame progress through the product perf bridge, verifies
 * navigator.gpu + adapter, and additionally gates p99 frame time, JS-heap growth and
 * navigation-to-ready / navigation-to-first-frame timings. Profiles:
 *   dev    (default) historical gate: p95 <= 100 ms; all new thresholds off.
 *   60hz   p95 <= 16.7 ms, p99 <= 33 ms, JS-heap growth <= 32 MB.
 *   custom starts from the dev budget; only thresholds passed explicitly are enabled.
 * Optional overrides: --p95-ms, --p99-ms, --heap-growth-mb, --ready-ms, --first-frame-ms.
 * Exits non-zero when WebGPU/rendering is unavailable or a threshold is exceeded. Not part
 * of scripts/verify.ps1 because it requires a GPU/browser environment; record the JSON
 * evidence in docs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRendererReady, renderGateFailures, resolveRenderGateThresholds } from './render_perf_checks.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const targetUrl = new URL(arg('url', 'http://127.0.0.1:5173/fabs/FAB-01/3d'));
targetUrl.searchParams.set('perf', '1');
const url = targetUrl.href;
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const frames = Number(arg('frames', '180'));
const warmupFrames = Number(arg('warmup', '30'));
const timeoutMs = Number(arg('timeout', '60000'));
const out = arg('out', path.join(root, '.local/render-perf.json'));
if (!Number.isInteger(frames) || frames < 1 || !Number.isInteger(warmupFrames) || warmupFrames < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid frame count or timeout');
const profile = arg('profile', 'dev');
if (!['dev', '60hz', 'custom'].includes(profile)) throw new Error(`Invalid --profile: ${profile} (expected dev, 60hz or custom)`);
const optionalNumber = (name) => {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
};
const gateOptions = { profile };
for (const [option, name] of [['p95Ms', 'p95-ms'], ['p99Ms', 'p99-ms'], ['heapGrowthMb', 'heap-growth-mb'], ['readyMs', 'ready-ms'], ['firstFrameMs', 'first-frame-ms']]) {
  const value = optionalNumber(name);
  if (value !== undefined) gateOptions[option] = value;
}
const thresholds = resolveRenderGateThresholds(gateOptions);
const port = 9300 + Math.floor(Math.random() * 300);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(path.join(root, '.local'), { recursive: true });
const userDir = fs.mkdtempSync(path.join(root, '.local/render-perf-chrome-'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--use-angle=d3d11', '--disable-gpu-sandbox',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', url,
], { stdio: 'ignore', windowsHide: true });

let ws;
let readiness;
const browserErrors = [];
try {
  let version;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { version = await response.json(); break; }
    } catch { /* Chrome not ready. */ }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find((entry) => entry.type === 'page');
  if (!page) throw new Error('Chrome page target not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') browserErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'page evaluation failed');
    return result.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Performance.enable');

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    readiness = await evaluate(`(() => {
      const bridge = window.__SEMICONFAB_PERF__;
      const stats = bridge?.getStats();
      return { ready: document.readyState, pageNow: performance.now(), text: document.body?.innerText.slice(-400), canvas: !!document.querySelector('canvas'),
        renderer: bridge ? { status: bridge.getLifecycle().status, frames: stats.frames, drawCalls: stats.drawCalls } : null,
        gpuErrors: bridge?.getDiagnostics()?.gpuErrors ?? [] };
    })()`).catch(() => undefined);
    if (isRendererReady(readiness)) break;
    if (browserErrors.length || readiness?.gpuErrors?.length) throw new Error('Renderer reported GPU or browser errors');
    await sleep(500);
  }
  if (!isRendererReady(readiness)) throw new Error('Renderer did not become ready before timeout');
  // Navigation-relative boot timing: performance.now() is measured from page navigation start.
  const readyMs = Number.isFinite(readiness.pageNow) ? readiness.pageNow : null;
  const metricMap = (result) => Object.fromEntries((result.result?.metrics ?? []).map((entry) => [entry.name, entry.value]));
  const startMetrics = metricMap(await send('Performance.getMetrics'));
  // Heap trend: keep sampling Performance.getMetrics while the RAF window is measured, so
  // growth is derived from a real trend instead of only the start/end snapshots.
  const windowHeapSamples = [];
  let heapSampling = true;
  const heapSampler = (async () => {
    while (heapSampling) {
      try {
        const snapshot = metricMap(await send('Performance.getMetrics'));
        if (Number.isFinite(snapshot.JSHeapUsedSize)) windowHeapSamples.push(snapshot.JSHeapUsedSize);
      } catch { /* The page may be closing; the start/end snapshots still bound the trend. */ }
      await sleep(100);
    }
  })();
  let measurement;
  try {
    measurement = await evaluate(`(async () => {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      const bridge = window.__SEMICONFAB_PERF__;
      let stageTimings = null;
      try { stageTimings = typeof bridge.getStageTimings === 'function' ? bridge.getStageTimings() : null; } catch { stageTimings = null; }
      const initialFrames = bridge.getStats().frames;
      let firstFrameMs = null;
      const deltas = await new Promise((resolve) => {
        const values = [];
        let last = 0;
        let lastFrames = initialFrames;
        const deadline = performance.now() + Math.max(20000, (${frames + warmupFrames}) * 50);
        function tick(now) {
          const stats = bridge.getStats();
          // Count intervals only when the engine actually renders a new frame.
          if (stats.frames > lastFrames) {
            if (firstFrameMs === null) firstFrameMs = now;
            if (last) values.push(now - last);
            last = now;
            lastFrames = stats.frames;
          }
          if (values.length >= ${frames + warmupFrames} || performance.now() > deadline) { resolve(values); return; }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }).catch(() => []);
      return {
        secure: isSecureContext,
        gpu: !!navigator.gpu,
        adapter: !!adapter,
        adapterInfo: adapter?.info ?? null,
        canvas: !!document.querySelector('canvas'),
        bodyText: document.body ? document.body.innerText.slice(-600) : '',
        canvasSize: (() => { const c = document.querySelector('canvas'); return c ? { width: c.width, height: c.height } : null; })(),
        rendererReady: bridge.getLifecycle().status === 'ready',
        rendererFrames: bridge.getStats().frames - initialFrames,
        drawCalls: bridge.getStats().drawCalls,
        gpuErrors: bridge.getDiagnostics()?.gpuErrors ?? [],
        deltas,
        firstFrameMs,
        stageTimings,
      };
    })()`, true);
  } finally {
    heapSampling = false;
    await heapSampler;
  }
  const endMetrics = metricMap(await send('Performance.getMetrics'));
  const workerTargets = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).filter((entry) => entry.type === 'worker').length;

  const allDeltas = measurement.deltas.filter((value) => Number.isFinite(value) && value > 0);
  const deltas = allDeltas.slice(warmupFrames);
  const sorted = [...deltas].sort((a, b) => a - b);
  const average = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
  const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
  // p95 and p99 are derived from the same warmup-trimmed RAF-delta samples as the original gate.
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  // JS-heap trend: end - minimum of the start/window/end samples, so a mid-window dip cannot hide a leak.
  const heapStartBytes = startMetrics.JSHeapUsedSize;
  const heapEndBytes = endMetrics.JSHeapUsedSize;
  const heapPointBytes = [heapStartBytes, ...windowHeapSamples, heapEndBytes].filter((value) => Number.isFinite(value));
  const heapGrowthMb = Number.isFinite(heapEndBytes) && heapPointBytes.length >= 2
    ? (heapEndBytes - Math.min(...heapPointBytes)) / 1024 / 1024 : null;
  const firstFrameMs = Number.isFinite(measurement.firstFrameMs) ? measurement.firstFrameMs : null;
  const gpuErrors = [...measurement.gpuErrors, ...browserErrors];
  const failures = renderGateFailures({
    ...measurement, gpuErrors, measuredFrames: deltas.length, p95FrameMs: p95, p99FrameMs: p99,
    heapGrowthMb, readyMs, firstFrameMs,
  }, frames, gateOptions);
  const report = {
    measuredAt: new Date().toISOString(),
    browser: version.Browser,
    url,
    profile: thresholds.profile,
    thresholds,
    frames: deltas.length,
    averageFrameMs: Number(average.toFixed(2)),
    p95FrameMs: Number(p95.toFixed(2)),
    p99FrameMs: Number(p99.toFixed(2)),
    averageFps: Number((1000 / Math.max(1, average)).toFixed(1)),
    minFrameMs: Number((sorted[0] ?? 0).toFixed(2)),
    maxFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    secure: measurement.secure,
    gpu: measurement.gpu,
    adapter: measurement.adapter,
    adapterInfo: measurement.adapterInfo,
    canvas: measurement.canvas,
    canvasSize: measurement.canvasSize,
    rendererFrames: measurement.rendererFrames,
    drawCalls: measurement.drawCalls,
    workerTargets,
    readyMs: readyMs === null ? null : Number(readyMs.toFixed(1)),
    firstFrameMs: firstFrameMs === null ? null : Number(firstFrameMs.toFixed(1)),
    stageTimings: measurement.stageTimings ?? null,
    heapSamples: windowHeapSamples.length,
    heapGrowthMb: heapGrowthMb === null ? null : Number(heapGrowthMb.toFixed(2)),
    jsHeapUsedMb: Number(((endMetrics.JSHeapUsedSize ?? 0) / 1024 / 1024).toFixed(2)),
    jsHeapDeltaMb: Number((((endMetrics.JSHeapUsedSize ?? 0) - (startMetrics.JSHeapUsedSize ?? 0)) / 1024 / 1024).toFixed(2)),
    taskDurationMs: Number((((endMetrics.TaskDuration ?? 0) - (startMetrics.TaskDuration ?? 0)) * 1000).toFixed(2)),
    scriptDurationMs: Number((((endMetrics.ScriptDuration ?? 0) - (startMetrics.ScriptDuration ?? 0)) * 1000).toFixed(2)),
    gpuErrors,
    failures,
    bodyText: measurement.bodyText,
    readiness,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error('render_perf failed:', error instanceof Error ? error.message : error);
  fs.writeFileSync(out, JSON.stringify({ url, error: error instanceof Error ? error.message : String(error), readiness, browserErrors }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  try {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ id: 1000000, method: 'Browser.close' }));
    ws?.close();
  } catch { /* ignore */ }
  child.kill();
}
