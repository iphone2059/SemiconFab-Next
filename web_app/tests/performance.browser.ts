// Standalone WebGPU performance harness. Requires the dev server and a dedicated
// Chromium CDP port. It records a real browser baseline; it is not a CI unit test.
import { writeFileSync } from 'node:fs';
import { summarizeFrames, summarizeLongTasks } from './support/perf-metrics.ts';

const port = Number(process.env.PERF_CDP_PORT ?? '9336');
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find((value: { type: string }) => value.type === 'page');
if (!tab) throw new Error('No isolated browser page');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
});
const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 120_000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string): Promise<any> => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('stage:connected');
await command('Runtime.enable');
await command('Page.enable');
await command('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await command('Page.navigate', { url: 'http://127.0.0.1:5173/' });
await wait(1000);
const fabHref = await evaluate(`document.querySelector('a[href*="/3d"]')?.getAttribute('href') ?? ''`);
if (!fabHref) throw new Error('workbench 3D FAB link is missing');
await command('Page.navigate', { url: new URL(fabHref, 'http://127.0.0.1:5173').toString() + '?lang=en&perf=1' });
for (let attempt = 0; attempt < 90; attempt += 1) {
  await wait(250);
  try {
    if (await evaluate(`!!document.querySelector('canvas') && !!window.__SEMICONFAB_PERF__`)) break;
  } catch { /* page still booting */ }
}
await wait(1500);
console.log('stage:page-ready');
if (await evaluate(`!!document.querySelector('.twin-onboarding')`)) await evaluate(`document.querySelector('.twin-onboarding-head button').click()`);
console.log('stage:adapter');
const pageInfo = await evaluate(`(async () => {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
    webgpuAdapterInfo: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null,
  };
})()`);

const sample = async (durationMs: number): Promise<any> => evaluate(`(async () => {
  const start = performance.now();
  const frames = [];
  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.startTime >= start) longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
  });
  try { observer.observe({ type: 'longtask', buffered: false }); } catch {}
  let last = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      frames.push(Math.max(0, now - last));
      last = now;
      if (now - start >= ${durationMs}) resolve(undefined);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  observer.disconnect();
  return { frames, longTasks, durationMs: performance.now() - start, scene: window.__SEMICONFAB_PERF__?.getStats() ?? null };
})()`);

console.log('stage:warmup');
await wait(5000);
console.log('stage:idle');
const idle = await sample(10_000);
console.log('stage:orbit');
const orbitPromise = sample(8_000);
await wait(300);
await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 500, button: 'left', buttons: 1, clickCount: 1 });
for (let step = 1; step <= 40; step += 1) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900 + step * 6, y: 500 + Math.sin(step / 4) * 40, button: 'left', buttons: 1 });
  await wait(50);
}
await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1140, y: 500, button: 'left', buttons: 0, clickCount: 1 });
const orbit = await orbitPromise;
const summarize = (result: any) => ({ frame: summarizeFrames(result.frames), longTasks: summarizeLongTasks(result.longTasks), scene: result.scene, durationMs: result.durationMs });
const report = {
  capturedAt: new Date().toISOString(),
  viewport: '1920x1080 DPR 1',
  query: '?lang=en&perf=1&hoverPickMs=50',
  pageInfo,
  warmupMs: 5000,
  scenarios: { idle: summarize(idle), orbit: summarize(orbit) },
};
const output = process.env.PERF_OUTPUT ?? '../.local/twin-perf-baseline.json';
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
socket.close();
