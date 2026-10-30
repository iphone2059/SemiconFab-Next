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
// CR-08: exercise the device-loss rebuild budget circuit breaker on real WebGPU too. The
// acceptance-only ?perf seam lets the page use a small budget instead of injecting ~96 losses.
const circuitBreakerEnabled = arg('circuit-breaker', '1') !== '0';
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
  '  window.__FAB_GPU_DESTROYED__ = 0;',
  '  window.__FAB_GPU_TRACE__ = [];',
  '  const record = (kind, value) => window.__FAB_GPU_TRACE__.push({ at: Date.now(), kind, value: String(value) });',
  '  try {',
  '    if (window.GPUDevice && window.GPUDevice.prototype.destroy) {',
  '      const originalDestroy = window.GPUDevice.prototype.destroy;',
  '      window.GPUDevice.prototype.destroy = function (...args) { window.__FAB_GPU_DESTROYED__ += 1; record("destroy", "destroyed#" + window.__FAB_GPU_DESTROYED__); return originalDestroy.apply(this, args); };',
  '    }',
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
const perfState = (browser) => browser.evaluate('(() => { const perf = window.__SEMICONFAB_PERF__; if (!perf) return null; const lifecycle = perf.getLifecycle(); const created = window.__FAB_GPU_DEVICES__.length; const destroyed = window.__FAB_GPU_DESTROYED__; return { status: lifecycle.status, statuses: lifecycle.statuses, losses: lifecycle.losses, recoveries: lifecycle.recoveries, lastStatus: lifecycle.lastStatus, devices: created, destroyed, liveDevices: created - destroyed }; })()');

let browser;
let profileDir;
const results = {
  generatedAt: now(), commit, webUrl, apiUrl, fabId, durationSeconds, minCycles,
  chromium: null, adapter: null, contexts: null, injectionMethod: 'perf.forceDeviceLoss',
  initial: null, cycles: [], heapSamples: [], lifecycleTrace: [], auxiliaryProbe: null,
  circuitBreaker: null,
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
  // Injection cadence: a smoke run recovers back-to-back; a long soak uses a realistic
  // device-loss cadence (about 40 losses across the window) instead of hammering Chrome's
  // GPU process with >100 device recreations per 10 minutes, which exhausts the driver's
  // D3D12 descriptor heap at the browser level (observed at cycle 131, see limitations).
  const cycleIntervalMs = Number(arg('cycle-interval-ms', durationSeconds <= 180 ? '500' : String(Math.max(1000, Math.floor((durationSeconds * 1000) / 40)))));
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
      before: before ? { losses: before.losses, recoveries: before.recoveries, devices: before.devices, liveDevices: before.liveDevices } : null,
      after: cycleState ? { losses: cycleState.losses, recoveries: cycleState.recoveries, devices: cycleState.devices, liveDevices: cycleState.liveDevices, status: cycleState.status } : null,
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
    await sleep(cycleIntervalMs);
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
  // Capture the main-gate device budget before the circuit-breaker probe navigates away.
  const mainFinalPerf = await perfState(browser).catch(() => null);
  results.finalDevices = mainFinalPerf ? { created: mainFinalPerf.devices, destroyed: mainFinalPerf.destroyed, live: mainFinalPerf.liveDevices } : null;

  // CR-08 circuit-breaker probe: on a fresh page with the acceptance budget (?perf&recoveryBudget=8),
  // rapid device losses must hit the budget, fail closed, fully release, and stop creating GPUDevices.
  // The probe deliberately ends in the controlled failed state; the main gate evidence above is
  // already captured, and probe console output is reported separately from the main consoleErrors.
  if (circuitBreakerEnabled) {
    const probe = {
      enabled: true, budget: null, attempts: 0, failClosed: false,
      devicesBefore: null, devicesAfter: null, pageAlive: null, budgetMessageSeen: false,
      consoleErrors: [], pass: false, error: null,
    };
    const probeBaseline = browser.consoleErrors.length;
    try {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d?perf&recoveryBudget=8', 'document.querySelector("canvas")');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU") && !document.querySelector(".twin-render-status")', 90000, 'probe WebGPU ready');
      const initialLifecycle = await browser.evaluate('window.__SEMICONFAB_PERF__ ? window.__SEMICONFAB_PERF__.getLifecycle() : null');
      probe.budget = initialLifecycle ? initialLifecycle.recoveryBudget ?? null : null;
      if (!probe.budget || probe.budget > 8) throw new Error('acceptance recoveryBudget override was not applied (got ' + probe.budget + ')');
      // A device loss can only be injected from a ready scene (the recovery rebuild makes the
      // world imperative handle unavailable in between). Wait for ready, inject exactly one loss,
      // then wait until the loss is observed / the scene fails closed before injecting again.
      const probeLifecycle = async () => {
        const state = await browser.evaluate('(() => { const p = window.__SEMICONFAB_PERF__; if (!p) return { open: false }; const lifecycle = p.getLifecycle(); return { open: true, status: lifecycle.status, failClosed: lifecycle.failClosed === true }; })()').catch(() => null);
        return state;
      };
      const waitProbeReady = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await probeLifecycle();
          if (state === null) { await sleep(200); continue; }
          if (!state.open || state.failClosed) return 'closed';
          if (state.status === 'ready') return 'ready';
          await sleep(200);
        }
        return 'timeout';
      };
      const waitProbeSettled = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await probeLifecycle();
          if (state === null) { await sleep(150); continue; }
          if (!state.open || state.failClosed) return 'closed';
          if (state.status !== 'ready') return 'busy';
          await sleep(150);
        }
        return 'timeout';
      };
      const maxAttempts = probe.budget + 5;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const readiness = await waitProbeReady(30000);
        if (readiness === 'closed') { probe.failClosed = true; break; }
        if (readiness !== 'ready') { probe.readyTimeout = true; break; }
        const step = await browser.evaluate('(() => { try { const p = window.__SEMICONFAB_PERF__; if (!p || typeof p.forceDeviceLoss !== "function") return "closed"; p.forceDeviceLoss(); return "injected"; } catch (error) { return "error:" + String(error); } })()').catch(() => 'unknown');
        if (step !== 'injected') { probe.failClosed = step === 'closed'; break; }
        probe.attempts += 1;
        const settled = await waitProbeSettled(10000);
        if (settled === 'closed') { probe.failClosed = true; break; }
        if (settled === 'timeout') { probe.settleTimeout = true; break; }
      }
      // Controlled fail-closed means: after the budget trip, device creation stops (two samples two
      // seconds apart are equal) and live devices stay released-bounded. One replacement device may
      // still be finishing the recovery that was already in flight when the budget tripped; that is
      // fine only if it is released and no further devices are created.
      const sampleDevices = () => browser.evaluate('({ created: (window.__FAB_GPU_DEVICES__ ?? []).length, destroyed: window.__FAB_GPU_DESTROYED__ ?? 0, live: (window.__FAB_GPU_DEVICES__ ?? []).length - (window.__FAB_GPU_DESTROYED__ ?? 0) })');
      probe.devicesAtFailClosed = await sampleDevices();
      await sleep(2000);
      probe.deviceSample1 = await sampleDevices();
      await sleep(2000);
      probe.deviceSample2 = await sampleDevices();
      probe.pageAlive = await browser.evaluate('typeof document !== "undefined" && !!document.body').catch(() => false);
      probe.consoleErrors = browser.consoleErrors.slice(probeBaseline).filter((entry) => !/net::ERR_FAILED|Failed to load resource/.test(entry)).slice(-10);
      probe.budgetMessageSeen = browser.consoleErrors.slice(probeBaseline).some((entry) => /重建预算|recovery budget exhausted/i.test(entry));
      probe.inFlightDeviceCreated = probe.deviceSample2.created > probe.devicesAtFailClosed.created;
      probe.pass = probe.failClosed === true
        && probe.deviceSample2.created === probe.deviceSample1.created
        && probe.deviceSample2.live <= 2
        && probe.pageAlive === true
        && probe.budgetMessageSeen === true;
      if (probe.deviceSample2.created !== probe.deviceSample1.created) results.limitations.push('circuit breaker probe kept creating GPUDevices after fail-closed (' + probe.deviceSample1.created + ' -> ' + probe.deviceSample2.created + ')');
      if (probe.deviceSample2.live > 2) results.limitations.push('circuit breaker probe left ' + probe.deviceSample2.live + ' live GPUDevices after fail-closed (bound 2)');
      if (!probe.failClosed) results.limitations.push('circuit breaker probe did not fail closed within budget+5 device losses');
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
      results.limitations.push('circuit breaker probe failed to run: ' + probe.error);
    }
    results.circuitBreaker = probe;
  }

  const injectedCycles = results.cycles.filter((cycle) => cycle.injected).length;
  const recoveredCycles = results.cycles.filter((cycle) => cycle.injected && cycle.recovered).length;
  results.recoveries = { injected: injectedCycles, recovered: recoveredCycles, sawLoss: results.cycles.filter((cycle) => cycle.sawLoss).length };
  const liveBoundOk = results.finalDevices === null || results.finalDevices.live <= 8;
  const circuitBreakerOk = !circuitBreakerEnabled || results.circuitBreaker?.pass === true;
  results.pass = injectedCycles >= minCycles && recoveredCycles === injectedCycles
    && results.finalState !== null && results.finalState.ready === true
    && results.finalState.webgl === false && results.finalState.webgl2 === false
    && results.consoleErrors.length === 0
    && liveBoundOk && circuitBreakerOk;
  if (results.finalDevices && !liveBoundOk) results.limitations.push('live GPUDevice count grew to ' + results.finalDevices.live + ' (bound 8): repeated forceDeviceLoss may leak replacement devices.');
  if (!results.pass) results.limitations.push('device-loss gate requires ' + minCycles + '+ forceDeviceLoss cycles, all recovered, final WebGPU-ready state, no WebGL fallback, no console errors, bounded live GPUDevices and a passing CR-08 circuit-breaker probe.');
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
  console.log((results.pass ? 'GPU GATE PASS' : 'GPU GATE FAIL') + ' cycles=' + results.cycles.length + ' recovered=' + (results.recoveries?.recovered ?? 0) + '/' + (results.recoveries?.injected ?? 0) + ' method=' + results.injectionMethod + ' liveDevices=' + JSON.stringify(results.finalDevices?.live ?? null) + ' auxCrashRecovered=' + JSON.stringify(results.auxiliaryProbe?.recovered ?? null) + ' circuitBreaker=' + JSON.stringify(results.circuitBreaker ? { failClosed: results.circuitBreaker.failClosed, pass: results.circuitBreaker.pass } : null));
  console.log('report: ' + out);
  try { browser?.close(); } catch { /* ignore */ }
  await sleep(500);
  if (profileDir) removeProfile(profileDir);
  if (!results.pass) process.exitCode = 1;
}
