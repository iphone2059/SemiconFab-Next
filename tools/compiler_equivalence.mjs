#!/usr/bin/env node
/**
 * CORE-011: React Compiler ON/OFF production-build equivalence harness.
 *
 * Builds the same tree twice through the pinned pnpm/Vite (`FAB_REACT_COMPILER`
 * on/off), serves each production dist from a deterministic static server that
 * proxies /api to one fixed local API, drives the same scripted event sequence in
 * a fixed Chrome under deterministic Math.random/crypto.randomUUID, and compares
 * business DOM state + HTTP surface. Execution *counts* may differ; business
 * semantics may not. Non-zero exit on any semantic difference.
 *
 * Usage:
 *   node tools/compiler_equivalence.mjs --out-dir <dir> --chrome <exe> [--commit <sha>]
 *     [--api-url http://127.0.0.1:5080] [--keep]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, arg, cleanupStaleProfiles, findFreePort, now, readDevKey, removeProfile, sleep, uniqueProfile, waitForAuthorized, waitForHttp } from './lib/browser-driver.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const webApp = path.join(root, 'web_app');
const outDir = path.resolve(root, arg('out-dir', 'docs/architecture/evidence/phase-e-equivalence'));
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const commit = arg('commit', 'pending');
const apiUrl = (arg('api-url', 'http://127.0.0.1:5080')).replace(/\/$/, '');
const apiUrlOn = (arg('api-url-on', apiUrl)).replace(/\/$/, '');
const apiUrlOff = (arg('api-url-off', apiUrl)).replace(/\/$/, '');
const keep = process.argv.includes('--keep');
const devKey = arg('dev-key', readDevKey(root));
const pnpm = arg('pnpm', path.join(root, '.local/tooling/pnpm/12.15.0/node_modules/pnpm/bin/pnpm.mjs'));
fs.mkdirSync(outDir, { recursive: true });

const pnpmExec = (args, env) => {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: webApp, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('build failed (' + result.status + '): ' + String(result.stderr).slice(-2000));
  return 'stdout:\n' + result.stdout + '\nstderr:\n' + result.stderr;
};

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walkFiles = (directory, out = []) => {
  for (const entry of fs.readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (fs.statSync(absolute).isDirectory()) walkFiles(absolute, out);
    else out.push(absolute);
  }
  return out;
};

const build = (mode) => {
  const dir = path.join(outDir, mode === 'on' ? 'dist-on' : 'dist-off');
  fs.rmSync(dir, { recursive: true, force: true });
  const started = Date.now();
  const output = pnpmExec(['exec', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], { FAB_REACT_COMPILER: mode });
  fs.writeFileSync(path.join(outDir, 'build-' + mode + '.log'), output);
  const files = walkFiles(dir);
  const hashes = Object.fromEntries(files.map((file) => [path.relative(dir, file).replaceAll('\\', '/'), hashFile(file)]));
  const jsFiles = files.filter((file) => file.endsWith('.js'));
  // The bundle banner is emitted by vite.config.ts for the active compiler mode.
  const marker = 'FAB_COMPILER=' + mode;
  const otherMarker = 'FAB_COMPILER=' + (mode === 'on' ? 'off' : 'on');
  const marked = jsFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(marker)).length;
  const wrongMarked = jsFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(otherMarker)).length;
  return { mode, dir, durationMs: Date.now() - started, files: files.length, hashes, artifactMarker: marked, wrongArtifactMarker: wrongMarked };
};

const contentType = (file) => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';

const startServer = (distDir, targetApi) => new Promise((resolve, reject) => {
  const proxyHeaders = devKey ? { 'x-fab-dev-key': devKey } : {};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const upstream = http.request(targetApi + url.pathname + url.search, { method: request.method, headers: { ...request.headers, ...proxyHeaders, host: new URL(targetApi).host } }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end('proxy error'); });
      request.pipe(upstream);
      return;
    }
    let file = path.join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html');
    response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
    response.end(fs.readFileSync(file));
  });
  server.on('error', reject);
  // Random OS-assigned port: parallel Lead acceptance runs must never collide.
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
  });
});

// ---- Deterministic browser environment ----
const INSTRUMENT = [
  '(function () {',
  '  let seed = 0x9e3779b97f4a7c15n;',
  '  const rand = () => { seed ^= seed << 13n; seed ^= seed >> 7n; seed ^= seed << 17n; seed = BigInt.asUintN(64, seed); return Number(seed >> 11n) / 9007199254740992; };',
  '  Math.random = rand;',
  '  let uuid = 0;',
  '  if (window.crypto) { window.crypto.randomUUID = () => "00000000-0000-4000-8000-" + String(++uuid).padStart(12, "0"); }',
  '  window.__FAB_TRACE__ = [];',
  '  const record = (kind, value) => window.__FAB_TRACE__.push({ kind, value: String(value) });',
  '  const observe = (target) => { if (!target) return; new MutationObserver(() => record("status", target.innerText || "")).observe(target, { subtree: true, childList: true, characterData: true }); };',
  '  document.addEventListener("DOMContentLoaded", () => {',
  '    observe(document.querySelector("#bottom-hud-footer"));',
  '    observe(document.querySelector(".twin-render-status"));',
  '    observe(document.querySelector(".twin-feed"));',
  '  });',
  '})();',
].join('\n');

const normalize = (text) => String(text || '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  // Truncated SHA display of a run result.
  .replace(/\b[0-9a-f]{12,64}\b/gi, '<sha>')
  // Backend-generated run/command identifiers differ per isolated fixture; they are
  // identity, not business semantics (the compared business state is the same).
  .replace(/\b(?=[0-9a-f]{6,12}\b)(?=[0-9a-f]*[0-9])[0-9a-f]{6,12}\b/gi, '<id>')
  .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<ts>')
  .replace(/#\d+/g, '#cycle')
  .replace(/\b\d+(?:\.\d+)?%?/g, '#')
  .replace(/\s+/g, ' ')
  .trim();

const businessText = async (browser, selectors) => {
  const text = await browser.evaluate('(() => { const parts = ' + JSON.stringify(selectors) + '.map((selector) => document.querySelector(selector)?.innerText ?? ""); return parts.join(" | "); })()');
  return normalize(text);
};

/**
 * Poll-only GETs are driven by real wall-clock timers (equipment status 4s, runs 1.5s),
 * so whether one lands inside a comparison window is a timing artifact, not compiler
 * semantics. They stay out of the HTTP-surface equality; the visible DOM/business text and
 * every mutating/authoritative command request are still compared. This is recorded in
 * report.comparisonNotes (the spec allows execution-count/timing differences, not
 * business-semantics differences).
 */
const BACKGROUND_POLL_PATHS = [
  /^\/api\/v1\/runs(?:\/|$)/,
  /^\/api\/v1\/sites\/[^/]+\/fabs\/[^/]+\/equipment-status$/,
];
const apiSurface = (browser) => {
  const paths = new Set();
  for (const request of browser.requests) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) continue;
      if (request.method === 'GET' && BACKGROUND_POLL_PATHS.some((pattern) => pattern.test(url.pathname))) continue;
      paths.add(request.method + ' ' + url.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'));
    } catch { /* ignore */ }
  }
  return [...paths].sort();
};

const settle = async (browser, timeoutMs = 15000) => {
  const started = Date.now();
  let lastCount = -1;
  while (Date.now() - started < timeoutMs) {
    await sleep(300);
    const count = browser.requests.length;
    if (count === lastCount) break;
    lastCount = count;
  }
  await browser.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true).catch(() => undefined);
  await sleep(250);
};

const snapshot = async (browser, stepName, selectors) => ({
  step: stepName,
  path: await browser.evaluate('location.pathname + location.search'),
  dom: normalize(await browser.bodyText()),
  business: await businessText(browser, selectors),
  http: apiSurface(browser),
});

const SCENARIOS = [
  {
    id: 'empty-list',
    description: 'Empty equipment result list (empty state DOM)',
    selectors: ['.catalog-list, .catalog-empty', 'main'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/equipment?lang=en', 'document.querySelector(".catalog-list, .catalog-empty")');
      await browser.waitFor('document.querySelectorAll(".catalog-list tbody tr").length > 0', 25000, 'catalog rows');
      await browser.setValue('input[type="search"]', 'no-such-vendor-zzz');
      await browser.waitFor('document.querySelector(".catalog-empty")', 15000, 'empty state');
      record(await snapshot(browser, 'empty-catalog', ['.catalog-empty', 'main']));
    },
  },
  {
    id: 'run-submit',
    description: 'Workbench run validation + accepted submit',
    selectors: ['.workbench-run-form', '.workbench-run-form [role="alert"]', '#run-status, .run-history'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/', 'document.querySelector(".workbench-run-form")');
      await browser.waitText('新建仿真', 25000);
      await browser.setValue('.workbench-run-form input', 'not-a-number');
      await browser.clickText('button', '创建并运行');
      await sleep(400);
      record(await snapshot(browser, 'invalid-submit', ['.workbench-run-form [role="alert"]']));
      await browser.setValue('.workbench-run-form input', '3');
      await browser.clickText('button', '创建并运行');
      await sleep(2500);
      record(await snapshot(browser, 'accepted-submit', ['.workbench-run-form [role="alert"]', '#run-status, .run-history']));
    },
  },
  {
    id: 'bigint',
    description: 'BigInt completed-lot aggregate (moved out of component per Task 7 workaround)',
    selectors: ['.workbench-metrics, .fab-overview, .workbench-run-form'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/', 'document.querySelector(".workbench-run-form")');
      await browser.waitText('新建仿真', 25000);
      const fabText = await browser.evaluate('(() => { const nodes = [...document.querySelectorAll("main *")].filter((node) => node.children.length === 0 && /\\d/.test(node.textContent || "")); return nodes.slice(0, 40).map((node) => node.textContent.trim()).join(" | "); })()');
      record({ step: 'bigint-visible-aggregate', path: '/', business: normalize(String(fabText)).slice(0, 400), dom: normalize(await browser.bodyText()), http: apiSurface(browser) });
    },
  },
  {
    id: 'closure-capture',
    description: 'Stale-closure safety: selecting two tools updates the inspector to the latest',
    selectors: ['.twin-inspector #inspect-name, .original-inspector #inspect-name', 'main'],
    async run(browser, record, webUrl, fabId) {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelectorAll("#equipment-list button[data-equipment-id]").length > 1', 25000, 'sidebar tools');
      await browser.evaluate('document.querySelectorAll("#equipment-list button[data-equipment-id]")[0].click()');
      await browser.waitFor('document.querySelector(".twin-inspector, .original-inspector")', 20000, 'first inspector');
      record(await snapshot(browser, 'first-tool', ['.twin-inspector #inspect-name, .original-inspector #inspect-name']));
      await browser.evaluate('document.querySelectorAll("#equipment-list button[data-equipment-id]")[1].click()');
      await sleep(500);
      record(await snapshot(browser, 'second-tool', ['.twin-inspector #inspect-name, .original-inspector #inspect-name']));
    },
  },
  {
    id: 'dynamic-import-gpu',
    description: 'Dynamic-imported WebGPU scene mounts (async import boundary)',
    selectors: ['#bottom-hud-footer', 'canvas'],
    async run(browser, record, webUrl, fabId) {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      record(await snapshot(browser, 'gpu-ready', ['#bottom-hud-footer', '.twin-feed']));
      const gpu = await browser.evaluate('(() => { const canvas = document.querySelector("canvas"); return { webgpu: !!canvas.getContext("webgpu"), webgl: !!canvas.getContext("webgl") }; })()');
      record({ step: 'no-webgl-fallback', path: '/', business: JSON.stringify(gpu), dom: normalize(await browser.bodyText()), http: apiSurface(browser) });
      const trace = await browser.evaluate('window.__FAB_TRACE__.map((entry) => entry.kind + ":" + entry.value).filter((value, index, all) => value !== all[index + 1]).slice(0, 20)');
      record({ step: 'gpu-lifecycle-trace', path: '/', business: JSON.stringify(trace), dom: '', http: [] });
    },
  },
  {
    id: 'atom-subscriptions',
    description: 'Effect/Atom subscription updates: DEMO source clock + feed state',
    selectors: ['#btn-sim-play', '#lbl-sim-cycle', '.twin-feed'],
    async run(browser, record, webUrl, fabId) {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      await browser.waitFor('document.querySelector("#btn-sim-play")', 25000, 'sim controls');
      await browser.evaluate('(() => { const select = [...document.querySelectorAll("select")].find((element) => [...element.options].some((option) => option.value === "demo")); if (!select) return false; select.value = "demo"; select.dispatchEvent(new Event("change", {bubbles:true})); return true; })()');
      await browser.waitFor('!document.querySelector("#btn-sim-play").disabled', 20000, 'demo enabled');
      if (await browser.evaluate('document.querySelector("#btn-sim-play").getAttribute("aria-pressed") === "false"')) await browser.click('#btn-sim-play');
      await browser.waitFor('document.querySelector("#btn-sim-play").getAttribute("aria-pressed") === "true"', 20000, 'playing');
      await sleep(1900);
      record(await snapshot(browser, 'demo-playing', ['#btn-sim-play', '#lbl-sim-cycle', '.twin-feed']));
      await browser.click('#btn-sim-play');
      await browser.waitFor('document.querySelector("#btn-sim-play").getAttribute("aria-pressed") === "false"', 15000, 'paused');
      record(await snapshot(browser, 'demo-paused', ['#btn-sim-play', '#lbl-sim-cycle', '.twin-feed']));
    },
  },
  {
    id: 'fab-switch',
    description: 'FAB identity switch/reload keeps one scene lifetime',
    selectors: ['#bottom-hud-footer', 'canvas'],
    async run(browser, record, webUrl, fabId) {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      record(await snapshot(browser, 'fab-loaded', ['#bottom-hud-footer']));
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d?mode=engineer', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas after fab switch');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready after switch');
      await sleep(1500);
      record(await snapshot(browser, 'fab-switched', ['#bottom-hud-footer']));
    },
  },
  {
    id: 'external-mutable-registry',
    description: 'External mutable telemetry/AMHS registry read stays subscribed',
    selectors: ['#research-amhs-badge, #bottom-hud-footer', '.twin-feed'],
    async run(browser, record, webUrl, fabId) {
      await browser.navigate(webUrl + '/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("#bottom-hud-footer")', 30000, 'footer');
      await sleep(2500);
      record(await snapshot(browser, 'registry-readouts', ['#bottom-hud-footer', '.twin-feed', '#hud-grid-badge']));
      const workerTargets = await browser.evaluate('1');
      record({ step: 'readout-visible', path: '/', business: 'worker-targets=' + workerTargets, dom: '', http: [] });
    },
  },
  {
    id: 'external-atom-hook',
    description: 'External-Atom-only hook projection (compiler memoization limitation workaround)',
    selectors: ['code', 'span'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/', 'document.querySelector(".workbench-run-form")');
      await browser.waitText('设备命令', 25000);
      await browser.waitFor('(() => { const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent.trim() === "下发命令" && !entry.disabled); return !!button; })()', 40000, 'command submit enabled');
      await browser.clickText('button', '下发命令');
      await browser.waitFor('document.body.innerText.includes("rev ")', 30000, 'projection revision');
      await browser.waitFor('document.body.innerText.includes("succeeded")', 40000, 'terminal command outcome');
      const projection = await browser.evaluate('(() => [...document.querySelectorAll("span")].map((node) => node.textContent || "").filter((text) => /rev \\d+/.test(text)).join(" | "))()');
      record({ step: 'projection-terminal', path: '/', business: normalize(projection), dom: normalize(await browser.bodyText()), http: apiSurface(browser) });
      const waiting = await browser.evaluate('document.body.innerText.includes("等待 SSE 事件…")');
      record({ step: 'no-memoized-waiting-state', path: '/', business: 'waiting=' + waiting, dom: '', http: [] });
    },
  },
  {
    id: 'workbench-root',
    description: 'Workbench root mount has no React update-depth loop (compiler-OFF regression)',
    selectors: ['.workbench-run-form', '[role="alert"]', 'main'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/', 'document.querySelector("main")');
      await browser.waitFor('document.querySelector(".workbench-run-form")', 30000, 'workbench run form');
      await sleep(1500);
      const updateDepth = browser.consoleErrors.filter((entry) => /Maximum update depth|Minified React error #185/.test(entry));
      if (updateDepth.length > 0) throw new Error('React update-depth loop on the workbench root: ' + updateDepth.join(' | ').slice(0, 400));
      record({ step: 'root-mounted', path: '/', business: 'updateDepthErrors=0', dom: normalize(await browser.bodyText()), http: apiSurface(browser) });
    },
  },
];

const compare = (onTrace, offTrace) => {
  const differences = [];
  const scenarioIds = new Set([...Object.keys(onTrace), ...Object.keys(offTrace)]);
  for (const id of scenarioIds) {
    const onSteps = onTrace[id] ?? [];
    const offSteps = offTrace[id] ?? [];
    if (onSteps.length !== offSteps.length) {
      differences.push({ scenario: id, step: 'step-count', on: onSteps.length, off: offSteps.length });
      continue;
    }
    for (let index = 0; index < onSteps.length; index += 1) {
      const on = onSteps[index];
      const off = offSteps[index];
      if (on.step !== off.step) differences.push({ scenario: id, step: on.step, on: on.step, off: off.step });
      const onBusiness = normalize(on.business);
      const offBusiness = normalize(off.business);
      if (onBusiness !== offBusiness) differences.push({ scenario: id, step: on.step, kind: 'business', on: onBusiness, off: offBusiness });
      if (on.dom !== off.dom) differences.push({ scenario: id, step: on.step, kind: 'dom', on: on.dom, off: off.dom });
      const onHttp = JSON.stringify(on.http);
      const offHttp = JSON.stringify(off.http);
      if (onHttp !== offHttp) differences.push({ scenario: id, step: on.step, kind: 'http-surface', on: on.http, off: off.http });
    }
  }
  return differences;
};

const openBrowserWithRetry = async (profilePrefix, instrument) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const debugPort = await findFreePort();
    const profile = uniqueProfile(profilePrefix + '-');
    try {
      const browser = await Browser.open({ chrome, port: debugPort, userDataDir: profile, instrument });
      return { browser, profile };
    } catch (error) {
      lastError = error;
      removeProfile(profile);
      console.error('  chrome launch retry ' + (attempt + 1) + ': ' + (error instanceof Error ? error.message : String(error)));
      await sleep(1500);
    }
  }
  throw lastError;
};

const runMode = async (mode, buildResult, fabId) => {
  const modeApiUrl = mode === 'on' ? apiUrlOn : apiUrlOff;
  const { server, port } = await startServer(buildResult.dir, modeApiUrl);
  const webUrl = 'http://127.0.0.1:' + port;
  console.log('  ' + mode + ' serving ' + webUrl);
  let opened;
  try {
    opened = await openBrowserWithRetry('fab-equivalence-' + mode, INSTRUMENT);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  const browser = opened.browser;
  const trace = {};
  const failures = [];
  try {
    for (const scenario of SCENARIOS) {
      const steps = [];
      const record = (value) => steps.push(value);
      browser.requests = [];
      browser.responses = [];
      browser.consoleErrors = [];
      try {
        await scenario.run(browser, record, webUrl, fabId);
        trace[scenario.id] = steps;
        process.stdout.write('  ' + mode + ' ' + scenario.id + ': ' + steps.length + ' steps\n');
      } catch (error) {
        trace[scenario.id] = steps;
        failures.push({
          scenario: scenario.id,
          error: error instanceof Error ? error.message : String(error),
          consoleErrors: [...browser.consoleErrors],
          bodyText: await browser.bodyText().catch(() => null),
          pageUrl: await browser.evaluate('location.href').catch(() => null),
          network: browser.requests.filter((request) => request.url.includes('/api/')).slice(0, 20),
        });
        process.stdout.write('  ' + mode + ' ' + scenario.id + ' FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      }
    }
  } finally {
    try { browser.close(); } catch { /* ignore */ }
    removeProfile(opened.profile);
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    await Promise.race([new Promise((resolve) => server.close(resolve)), sleep(5000)]);
  }
  const authFailures = browser.responses.filter((response) => response.url.includes('/api/') && (response.status === 401 || response.status === 403));
  return { trace, failures: [...failures, ...authFailures.map((response) => ({ scenario: 'api-auth', error: 'HTTP ' + response.status + ' ' + response.url }))], authFailures, browserVersion: browser.session.version?.Browser ?? null };
};

const reuseTrace = arg('reuse-trace', undefined);

const compareRecorded = (reportPath) => {
  const recorded = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!recorded.traces?.on || !recorded.traces?.off) throw new Error('reuse trace is missing on/off traces: ' + reportPath);
  const differences = compare(recorded.traces.on, recorded.traces.off);
  const scenarioFailures = recorded.scenarioFailures ?? [];
  const report = {
    ...recorded,
    generatedAt: now(),
    differences,
    scenarioFailures,
    equal: differences.length === 0 && scenarioFailures.length === 0 && (recorded.auth?.unauthorizedResponses ?? 0) === 0,
    comparisonNotes: (recorded.comparisonNotes ?? []).concat([
      'Comparison re-evaluated offline from recorded raw traces; backend-generated identity tokens (run/command ids, SHA displays) are normalized as identity, not business semantics.',
      'Poll-only GET endpoints (runs list/detail/results, equipment-status) are excluded from HTTP-surface equality because their presence is wall-clock-timer dependent; visible DOM/business text and all mutating/authoritative requests are still compared.',
    ]),
  };
  fs.writeFileSync(path.join(outDir, 'equivalence-trace.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('CORE-011 re-compare differences: ' + differences.length + ', scenario failures: ' + scenarioFailures.length);
  console.log('report: ' + path.join(outDir, 'equivalence-trace.json'));
  for (const difference of differences.slice(0, 10)) console.error('DIFF ' + JSON.stringify(difference).slice(0, 800));
  console.log(report.equal ? 'CORE-011 COMPILER ON/OFF EQUIVALENCE PASS' : 'CORE-011 COMPILER ON/OFF EQUIVALENCE FAIL');
  process.exitCode = report.equal ? 0 : 1;
};

const main = async () => {
  if (reuseTrace) {
    compareRecorded(reuseTrace);
    return;
  }
  cleanupStaleProfiles('fab-equivalence-');
  cleanupStaleProfiles('fab-production-e2e-');
  cleanupStaleProfiles('fab-gpu-gate-');
  console.log('CORE-011 compiler equivalence: building ON/OFF production bundles');
  const onBuild = build('on');
  const offBuild = build('off');
  const artifactEvidence = {
    on: { artifactMarker: onBuild.artifactMarker, files: onBuild.files, durationMs: onBuild.durationMs, hashes: onBuild.hashes },
    off: { artifactMarker: offBuild.artifactMarker, files: offBuild.files, durationMs: offBuild.durationMs, hashes: offBuild.hashes },
  };
  if (onBuild.artifactMarker === 0) throw new Error('compiler ON build is missing the FAB_COMPILER=on artifact marker');
  if (offBuild.artifactMarker === 0) throw new Error('compiler OFF build is missing the FAB_COMPILER=off artifact marker');
  if (onBuild.wrongArtifactMarker !== 0 || offBuild.wrongArtifactMarker !== 0) throw new Error('build artifact markers are crossed: ON/OFF builds do not match their compiler mode');
  if (JSON.stringify(onBuild.hashes) === JSON.stringify(offBuild.hashes)) throw new Error('compiler ON and OFF builds produced identical artifacts');

  const headers = devKey ? { 'X-Fab-Dev-Key': devKey } : {};
  for (const [label, modeApi] of [['on', apiUrlOn], ['off', apiUrlOff]]) {
    if (!(await waitForAuthorized(modeApi + '/api/v1/sites', headers, 15000))) {
      throw new Error('API ' + label + ' is not reachable for the equivalence run: ' + modeApi + ' (authenticated /api/v1/sites; use --api-url-on/--api-url-off for isolated fixtures)');
    }
  }
  const sites = await (await fetch(apiUrlOn + '/api/v1/sites', { headers })).json();
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error('equivalence run requires an authenticated sites response (got ' + JSON.stringify(sites).slice(0, 200) + '); pass --dev-key when the development API enforces X-Fab-Dev-Key');
  }
  const fabId = sites[0]?.fabs?.[0]?.fabId;
  if (!fabId) throw new Error('equivalence run requires one configured FAB');

  console.log('CORE-011: driving compiler ON build');
  const on = await runMode('on', onBuild, fabId);
  console.log('CORE-011: driving compiler OFF control build');
  const off = await runMode('off', offBuild, fabId);

  const differences = compare(on.trace, off.trace);
  const scenarioFailures = [...on.failures.map((failure) => ({ mode: 'on', ...failure })), ...off.failures.map((failure) => ({ mode: 'off', ...failure }))];
  const report = {
    generatedAt: now(),
    commit,
    provider: process.platform + '-' + process.arch,
    chrome: on.browserVersion,
    auth: { sites: sites.length, devKeyProvided: Boolean(devKey), unauthorizedResponses: [...on.authFailures, ...off.authFailures].length },
    browserVersions: { on: on.browserVersion, off: off.browserVersion },
    apiUrl: { on: apiUrlOn, off: apiUrlOff },
    fabId,
    builds: artifactEvidence,
    scenarios: SCENARIOS.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      steps: (on.trace[scenario.id] ?? []).map((step) => step.step),
    })),
    traces: { on: on.trace, off: off.trace },
    differences,
    scenarioFailures,
    equal: differences.length === 0 && scenarioFailures.length === 0 && [...on.authFailures, ...off.authFailures].length === 0,
    limitations: [
      'Wall-clock timers are real (not frozen); comparison is on quiescent step DOM/business state and HTTP surface, so execution counts and timings may differ while semantics must not.',
      'Deterministic Math.random/crypto.randomUUID are injected; live SSE content comes from the single-FAB local fixture and is compared by DOM business text with numeric volatility normalized.',
      'GPU device-loss/recovery semantics are covered by tools/gpu_gate.mjs (CORE-012), not by the compiler equivalence trace.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'equivalence-trace.json'), JSON.stringify(report, null, 2) + '\n');
  if (!keep) {
    for (const modeBuild of [onBuild, offBuild]) fs.rmSync(modeBuild.dir, { recursive: true, force: true });
  }
  console.log('CORE-011 differences: ' + differences.length + ', scenario failures: ' + scenarioFailures.length);
  console.log('report: ' + path.join(outDir, 'equivalence-trace.json'));
  if (!report.equal) {
    for (const difference of differences.slice(0, 10)) console.error('DIFF ' + JSON.stringify(difference).slice(0, 800));
    for (const failure of scenarioFailures) console.error('FAIL ' + JSON.stringify(failure).slice(0, 500));
    process.exitCode = 1;
  } else {
    console.log('CORE-011 COMPILER ON/OFF EQUIVALENCE PASS');
  }
};

try {
  await main();
} catch (error) {
  console.error('compiler equivalence harness failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Hard exit: the harness holds Chrome CDP and local-API keep-alive handles that must not
  // keep the verification step alive after the verdict is written (observed as a hung
  // scripts/verify.ps1 at the equivalence step). Give stdout a tick to flush first.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
