#!/usr/bin/env node
/**
 * CORE-012: real WebGPU device-loss/recovery gate on fixed local Chrome.
 *
 * Primary gate: the production page is opened with ?perf, which exposes the
 * acceptance-only window.__SEMICONFAB_PERF__ bridge. __SEMICONFAB_PERF__.forceDeviceLoss()
 * triggers the native Lite device-loss path (world.forceDeviceLoss), which is the
 * same recovery strategy a real device loss uses: product lifecycle recovering ->
 * ready, scene rebuild, no WebGL fallback. The gate runs N injection/recovery
 * cycles (or a duration soak), samples the JS heap and verifies there is no
 * WebGL fallback and no console error across generations.
 *
 * Additional probe (informational, not pass/fail): one Browser.crashGpuProcess
 * real GPU-process crash. Chrome 155 can enter a transient "adapter not available"
 * window while restarting its GPU process; that result is recorded as a limitation
 * instead of being silently ignored, and is not the injection granularity CORE-012
 * requires.
 *
 * Usage:
 *   node tools/gpu_gate.mjs --web-url <url> --api-url <url> --out <json> \
 *     --chrome <exe> --commit <sha> [--duration-seconds 600] [--cycles 3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, arg, cleanupStaleProfiles, findFreePort, now, readDevKey, removeProfile, sleep, uniqueProfile, waitForAuthorized, waitForHttp } from './lib/browser-driver.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const webUrl = (arg('web-url', 'http://127.0.0.1:4173')).replace(/\/$/, '');
const apiUrl = (arg('api-url', 'http://127.0.0.1:5080')).replace(/\/$/, '');
const out = arg('out', path.join(root, 'docs/architecture/evidence/phase-e-gpu.json'));
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const commit = arg('commit', 'pending');
const durationSeconds = Number(arg('duration-seconds', '600'));
const minCycles = Number(arg('cycles', '3'));
const screenshotDir = path.join(path.dirname(out), 'screenshots');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const devKey = readDevKey(root);
if (!(await waitForHttp(webUrl + '/', 8000))) { console.error('gpu gate web target not reachable: ' + webUrl); process.exit(2); }
if (!(await waitForAuthorized(apiUrl + '/api/v1/sites', devKey ? { 'X-Fab-Dev-Key': devKey } : {}, 15000))) { console.error('gpu gate API not reachable (authenticated /api/v1/sites): ' + apiUrl); process.exit(2); }
const sites = await (await fetch(apiUrl + '/api/v1/sites', { headers: devKey ? { 'X-Fab-Dev-Key': devKey } : {} })).json();
const fabId = sites[0]?.fabs?.[0]?.fabId;
if (!fabId) { console.error('gpu gate requires one configured FAB'); process.exit(2); }

const INSTRUMENT = [
  '(function () {',
  '  window.__FAB_GPU_DEVICES__ = [];',
  '  window.__FAB_GPU_TRACE__ = [];',
  '  const record = (kind, value) => window.__FAB_GPU_TRACE__.push({ at: Date.now(), kind, value: String(value) });',
  '  try {',
  '    if (window.GPUAdapter && window.GPUAdapter.prototype.requestDevice) {',
  '      const original = window.GPUAdapter.prototype.requestDevice;',
  '      window.GPUAdapter.prototype.requestDevice = async function (...args) {',
  '        const device = await original.apply(this, args);',
  '        window.__FAB_GPU_DEVICES__.push(device);',
  '        record("device", "created#" + window.__FAB_GPU_DEVICES__.length);',
  '        if (device.lost && typeof device.lost.then === "function") device.lost.then((info) => record("lost", info && info.reason ? info.reason : "destroyed"));',
  '        return device;',
  '      };',
  '    }',
  '  } catch (error) { record("instrument-error", String(error)); }',
  '  const observe = (target) => { if (!target) return; new MutationObserver(() => record("status", target.innerText || "")).observe(target, { subtree: true, childList: true, characterData: true }); };',
  '  document.addEventListener("DOMContentLoaded", () => { observe(document.querySelector("#bottom-hud-footer")); observe(document.querySelector(".twin-render-status")); });',
  '})();',
].join('\n');

const domState = (browser) => browser.evaluate('(() => { const footer = document.querySelector("#bottom-hud-footer"); return { footer: footer ? footer.innerText.replace(/\\s+/g, " ").trim() : "", renderStatus: document.querySelector(".twin-render-status")?.innerText ?? "", webgpu: !!document.querySelector("canvas")?.getContext("webgpu"), webgl: !!document.querySelector("canvas")?.getContext("webgl"), webgl2: !!document.querySelector("canvas")?.getContext("webgl2"), ready: !!footer && footer.innerText.includes("WebGPU") && !document.querySelector(".twin-render-status") }; })()');
const perfState = (browser) => browser.evaluate('(() => { const perf = window.__SEMICONFAB_PERF__; if (!perf) return null; const lifecycle = perf.getLifecycle(); return { status: lifecycle.status, statuses: lifecycle.statuses, losses: lifecycle.losses, recoveries: lifecycle.recoveries, lastStatus: lifecycle.lastStatus, devices: window.__FAB_GPU_DEVICES__.length }; })()');

let browser;
let profileDir;
const results = {
  generatedAt: now(), commit, webUrl, apiUrl, fabId, durationSeconds, minCycles,
  chromium: null, adapter: null, contexts: null, injectionMethod: 'perf.forceDeviceLoss',
  initial: null, cycles: [], heapSamples: [], lifecycleTrace: [], auxiliaryProbe: null,
  consoleErrors: [], limitations: [], pass: false,
};
cleanupStaleProfiles('fab-gpu-gate-');

try {
  profileDir = uniqueProfile('fab-gpu-gate-');
  browser = await Browser.open({ chrome, port: await findFreePort(), userDataDir: profileDir, instrument: INSTRUMENT });
  results.chromium = browser.session.version?.Browser ?? null;
  await browser.navigate(webUrl + '/fabs/' + fabId + '/3d?perf', 'document.querySelector("main.twin-page")');
  await browser.waitFor('document.querySelector("canvas")', 45000, 'twin canvas');
  await browser.waitFor('document.querySelector("#bottom-hud-footer") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU") && !document.querySelector(".twin-render-status")', 90000, 'WebGPU ready');
  await browser.waitFor('!!window.__SEMICONFAB_PERF__ && typeof window.__SEMICONFAB_PERF__.forceDeviceLoss === "function"', 30000, '?perf acceptance bridge');
  results.contexts = await domState(browser);
  if (!results.contexts.webgpu) throw new Error('canvas has no WebGPU context');
  if (results.contexts.webgl || results.contexts.webgl2) throw new Error('WebGL fallback context is present; the product must be WebGPU-only');
  results.adapter = await browser.evaluate('(async () => { if (!navigator.gpu) return null; const adapter = await navigator.gpu.requestAdapter(); if (!adapter) return null; const info = adapter.info ?? {}; return { vendor: info.vendor ?? "unknown", architecture: info.architecture ?? "unknown", device: info.device ?? "unknown", description: info.description ?? "unknown" }; })()', true);
  results.initial = await perfState(browser);
  results.screenshot = await browser.screenshot(path.join(screenshotDir, 'gpu-ready.png')).catch(() => null);

  const started = Date.now();
  const deadline = started + durationSeconds * 1000;
  while (true) {
    const before = await perfState(browser).catch(() => null);
    const cycleStart = Date.now();
    const injected = await browser.evaluate('(() => { const perf = window.__SEMICONFAB_PERF__; if (!perf || typeof perf.forceDeviceLoss !== "function") return false; perf.forceDeviceLoss(); return true; })()').catch(() => false);
    let recovered = false;
    let sawLoss = false;
    let cycleState = null;
    let statusesSeen = [];
    const cycleDeadline = Date.now() + 45000;
    while (injected && Date.now() < cycleDeadline) {
      await sleep(250);
      const state = await perfState(browser).catch(() => null);
      if (!state) continue;
      cycleState = state;
      statusesSeen = state.statuses.slice(-6);
      if (before && state.losses > before.losses) sawLoss = true;
      if (before && state.recoveries > before.recoveries && state.status === 'ready') { recovered = true; break; }
    }
    const dom = await domState(browser).catch(() => null);
    results.cycles.push({
      cycle: results.cycles.length + 1,
      injected,
      sawLoss,
      recovered,
      before: before ? { losses: before.losses, recoveries: before.recoveries, devices: before.devices } : null,
      after: cycleState ? { losses: cycleState.losses, recoveries: cycleState.recoveries, devices: cycleState.devices, status: cycleState.status } : null,
      statuses: statusesSeen,
      domReady: dom ? dom.ready : null,
      durationMs: Date.now() - cycleStart,
    });
    if (!injected) { results.limitations.push('forceDeviceLoss injection returned false'); break; }
    if (!recovered) { results.limitations.push('cycle ' + results.cycles.length + ' did not reach ready after forceDeviceLoss within 45s'); break; }
    if (results.cycles.length % 5 === 0 || results.cycles.length === minCycles) results.heapSamples.push({ at: new Date().toISOString(), cycle: results.cycles.length, ...(await browser.performance().catch(() => ({}))) });
    // Short smoke runs stop at the requested cycle count; soak runs keep cycling until the duration.
    if (durationSeconds <= 180 && results.cycles.length >= minCycles) break;
    if (Date.now() >= deadline) break;
    await sleep(500);
  }

  // Information-only: one real GPU-process crash. Chrome 155 may enter a transient
  // "adapter not available" window while restarting the GPU process; recorded honestly,
  // not used for the CORE-012 pass decision.
  const auxBefore = await perfState(browser).catch(() => null);
  try {
    await browser.send('Browser.crashGpuProcess', {});
    let auxRecovered = false;
    const auxDeadline = Date.now() + 60000;
    while (Date.now() < auxDeadline) {
      await sleep(500);
      const state = await perfState(browser).catch(() => null);
      const dom = await domState(browser).catch(() => null);
      if (state && state.recoveries > (auxBefore?.recoveries ?? 0) && state.status === 'ready') { auxRecovered = true; break; }
      if (dom && dom.ready && (!state || state.recoveries > (auxBefore?.recoveries ?? 0))) { auxRecovered = true; break; }
    }
    results.auxiliaryProbe = { method: 'Browser.crashGpuProcess', injected: true, recovered: auxRecovered, before: auxBefore, after: await perfState(browser).catch(() => null) };
    if (!auxRecovered) results.limitations.push('real GPU process crash probe did not recover within 60s (Chrome GPU-process restart window; not the CORE-012 injection granularity).');
  } catch (error) {
    results.auxiliaryProbe = { method: 'Browser.crashGpuProcess', injected: false, error: error instanceof Error ? error.message : String(error) };
    results.limitations.push('Browser.crashGpuProcess unavailable: ' + (error instanceof Error ? error.message : String(error)));
  }

  results.finalState = await domState(browser).catch(() => null);
  results.lifecycleTrace = await browser.evaluate('(window.__FAB_GPU_TRACE__ ?? []).map((entry) => entry.kind + ":" + entry.value).filter((value, position, all) => value !== all[position + 1]).slice(0, 100)').catch(() => []);
  results.consoleErrors = browser.consoleErrors.filter((entry) => !/net::ERR_FAILED|Failed to load resource|Page entered Back-Forward Cache/.test(entry));
  const injectedCycles = results.cycles.filter((cycle) => cycle.injected).length;
  const recoveredCycles = results.cycles.filter((cycle) => cycle.injected && cycle.recovered).length;
  results.recoveries = { injected: injectedCycles, recovered: recoveredCycles, sawLoss: results.cycles.filter((cycle) => cycle.sawLoss).length };
  results.pass = injectedCycles >= minCycles && recoveredCycles === injectedCycles
    && results.finalState !== null && results.finalState.ready === true
    && results.finalState.webgl === false && results.finalState.webgl2 === false
    && results.consoleErrors.length === 0;
  if (!results.pass) results.limitations.push('device-loss gate requires ' + minCycles + '+ forceDeviceLoss cycles, all recovered, final WebGPU-ready state, no WebGL fallback and no console errors.');
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  if (browser) {
    results.screenshot = await browser.screenshot(path.join(screenshotDir, 'gpu-failure.png')).catch(() => null);
    results.bodyText = await browser.bodyText().catch(() => null);
  }
} finally {
  results.finishedAt = now();
  results.consoleErrors = (browser?.consoleErrors ?? []).filter((entry) => !/net::ERR_FAILED|Failed to load resource|Page entered Back-Forward Cache/.test(entry));
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log((results.pass ? 'GPU GATE PASS' : 'GPU GATE FAIL') + ' cycles=' + results.cycles.length + ' recovered=' + (results.recoveries?.recovered ?? 0) + '/' + (results.recoveries?.injected ?? 0) + ' method=' + results.injectionMethod + ' auxCrashRecovered=' + JSON.stringify(results.auxiliaryProbe?.recovered ?? null));
  console.log('report: ' + out);
  try { browser?.close(); } catch { /* ignore */ }
  await sleep(500);
  if (profileDir) removeProfile(profileDir);
  if (!results.pass) process.exitCode = 1;
}
