#!/usr/bin/env node
/**
 * Real-browser sustained Worker telemetry stress (headless Chrome + Vite).
 *
 * Usage (start scripts/start-dev.ps1 first):
 *   node tools/telemetry_stress.mjs --url http://127.0.0.1:5173/tests/telemetry-stress.html
 *
 * The dedicated stress page (/tests/telemetry-stress.html) creates the actual
 * product Worker via createTelemetryWorker, initializes frame sizes for
 * 500/2000/5000 entities, posts Float32 frames at the requested rate for the
 * requested duration and measures cross-thread round-trip latency. Entity CPU
 * cost is also covered by tests/performance/telemetry-load.test.ts; product
 * WebGPU frame progress is covered by tools/render_perf.mjs.
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
const baseUrl = arg('url', 'http://127.0.0.1:5173/tests/telemetry-stress.html');
const seconds = Number(arg('seconds', '5'));
const rate = Number(arg('rate', '60'));
const entities = arg('entities', '500,2000,5000');
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const out = arg('out', path.join(root, '.local/telemetry-stress.json'));
const target = new URL(baseUrl);
target.searchParams.set('seconds', String(seconds));
target.searchParams.set('rate', String(rate));
target.searchParams.set('entities', entities);
const url = target.href;
const port = 9600 + Math.floor(Math.random() * 300);
const userDir = fs.mkdtempSync(path.join(root, '.local/telemetry-stress-chrome-'));
fs.mkdirSync(path.dirname(out), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--use-angle=d3d11', '--disable-gpu-sandbox',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', url,
], { stdio: 'ignore', windowsHide: true });

let ws;
try {
  let version;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { version = await response.json(); break; }
    } catch { /* not ready */ }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome DevTools endpoint did not start');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith('http'));
  if (!page) throw new Error('Chrome page target not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const browserErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') browserErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'page evaluation failed');
    return result.result?.result?.value;
  };
  await send('Runtime.enable');
  const deadline = Date.now() + 120000;
  let report;
  while (Date.now() < deadline) {
    report = await evaluate('window.__TELEMETRY_STRESS__').catch(() => undefined);
    if (report !== undefined) break;
    if (browserErrors.length) throw new Error('browser errors: ' + browserErrors.join('; '));
    await sleep(250);
  }
  if (!report || report.error) throw new Error(report?.error || 'telemetry stress page did not finish');
  const results = Array.isArray(report.results) ? report.results : [];
  const failures = [];
  for (const entry of results) {
    if (!entry || entry.errors?.length) failures.push(entry.entities + ': worker errors');
    else if (entry.receiveRatio < 0.9) failures.push(entry.entities + ': receiveRatio=' + entry.receiveRatio);
    else if (entry.p95LatencyMs > 100) failures.push(entry.entities + ': p95Latency=' + entry.p95LatencyMs + 'ms');
  }
  const finalReport = { measuredAt: new Date().toISOString(), browser: version.Browser, url, seconds, rate, results, failures, browserErrors };
  fs.writeFileSync(out, JSON.stringify(finalReport, null, 2) + '\n');
  console.log(JSON.stringify(finalReport, null, 2));
  process.exitCode = failures.length || browserErrors.length ? 1 : 0;
} catch (error) {
  console.error('telemetry_stress failed:', error instanceof Error ? error.message : error);
  fs.writeFileSync(out, JSON.stringify({ url, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
}
