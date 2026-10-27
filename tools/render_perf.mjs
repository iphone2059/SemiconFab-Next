#!/usr/bin/env node
/**
 * Real-browser WebGPU/render performance gate (headless Chrome, localhost secure context).
 *
 * Usage (start scripts/start-dev.ps1 first so API + Vite are running):
 *   node tools/render_perf.mjs --url http://127.0.0.1:5173/fabs/FAB-01/3d
 *
 * Measures requestAnimationFrame deltas on the real product route and verifies
 * navigator.gpu + adapter. Exits non-zero when WebGPU/rendering is unavailable
 * or p95 frame time exceeds the threshold. Not part of scripts/verify.ps1
 * because it requires a GPU/browser environment; record the JSON evidence in docs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:5173/fabs/FAB-01/3d');
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const frames = Number(arg('frames', '180'));
const warmupFrames = Number(arg('warmup', '30'));
const timeoutMs = Number(arg('timeout', '60000'));
const out = arg('out', path.join(root, '.local/render-perf.json'));
const port = 9300 + Math.floor(Math.random() * 300);
const userDir = path.join(root, '.local/render-perf-chrome');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(userDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--use-angle=d3d11', '--disable-gpu-sandbox',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', url,
], { stdio: 'ignore' });

let ws;
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
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'page evaluation failed');
    return result.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');

  const started = Date.now();
  let readiness;
  while (Date.now() - started < timeoutMs) {
    readiness = await evaluate("({ ready: document.readyState, text: document.body ? document.body.innerText.slice(-400) : '', canvas: !!document.querySelector('canvas') })").catch(() => undefined);
    if (readiness?.ready === 'complete' && readiness.canvas && /WebGPU|FAB|设备/.test(readiness.text)) break;
    await sleep(500);
  }
  const measurement = await evaluate(`(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    const deltas = await new Promise((resolve) => {
      const values = [];
      let last = 0;
      let count = 0;
      const deadline = performance.now() + 20000;
      function tick(now) {
        if (last) values.push(now - last);
        last = now;
        count += 1;
        if (count >= ${frames + warmupFrames} || performance.now() > deadline) { resolve(values); return; }
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
      deltas,
    };
  })()`, true);

  const allDeltas = measurement.deltas.filter((value) => Number.isFinite(value) && value > 0);
  const deltas = allDeltas.slice(warmupFrames);
  const sorted = [...deltas].sort((a, b) => a - b);
  const average = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const report = {
    measuredAt: new Date().toISOString(),
    browser: version.Browser,
    url,
    frames: deltas.length,
    averageFrameMs: Number(average.toFixed(2)),
    p95FrameMs: Number(p95.toFixed(2)),
    averageFps: Number((1000 / Math.max(1, average)).toFixed(1)),
    minFrameMs: Number((sorted[0] ?? 0).toFixed(2)),
    maxFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    secure: measurement.secure,
    gpu: measurement.gpu,
    adapter: measurement.adapter,
    adapterInfo: measurement.adapterInfo,
    canvas: measurement.canvas,
    canvasSize: measurement.canvasSize,
    bodyText: measurement.bodyText,
    readiness,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  const failed = !measurement.secure || !measurement.adapter || !measurement.canvas || deltas.length < Math.floor(frames * 0.8) || p95 > 100;
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error('render_perf failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
}
