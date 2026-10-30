#!/usr/bin/env node
/**
 * CORE-011: React Compiler ON/OFF production-build equivalence harness.
 *
 * Builds the same tree twice through the pinned pnpm/Vite (`FAB_REACT_COMPILER`
 * on/off), serves each production dist from a deterministic static server, drives
 * the same scripted event sequence in a fixed Chrome under deterministic
 * Math.random/crypto.randomUUID, and compares business DOM state + HTTP surface +
 * authoritative backend side effects. Non-zero exit on any semantic difference.
 *
 * Round 5.2 / P2-01: each mode proxies to its OWN isolated backend API with its own
 * Fab__DataDirectory database, both seeded from the same development fixture (the
 * caller resets both data directories and passes --api-url-on/--api-url-off). The run
 * aborts with "fixtures are not identical" when the two /api/v1/sites identities
 * diverge. Mutating scenarios pass a deterministic quiescence barrier (API request
 * set stable for quietMs, two identical DOM samples, two rAF) before the HTTP surface
 * is captured, and that surface is compared as method+path+count per scenario step,
 * not as a method+path set. After each mode the harness fetches that mode's
 * authoritative sites/commands/runs state and compares normalized side effects.
 *
 * Usage:
 *   node tools/compiler_equivalence.mjs --out-dir <dir> --chrome <exe> [--commit <sha>]
 *     --api-url-on http://127.0.0.1:5191 --api-url-off http://127.0.0.1:5192
 *     [--api-url http://127.0.0.1:5080] [--keep]
 *   node tools/compiler_equivalence.mjs --reuse-trace <equivalence-trace.json>
 *     (legacy offline re-compare of a previously recorded trace pair)
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

// Canonical composite FAB route: (siteId, fabId) are both required (ADR-007 §3).
const twinPath = (siteId, fabId) => '/sites/' + encodeURIComponent(siteId) + '/fabs/' + encodeURIComponent(fabId) + '/3d';

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
  // Round 5.2 / P2-01: live FDC/SPC control status is derived from each backend's
  // real-time simulation phase. ON/OFF now run against isolated backends (required by
  // the re-review), so the same wall-clock window can legitimately observe IN SPEC in
  // one process and OUT OF SPEC in the other. This status word is telemetry state, not
  // compiler output; all persisted side effects, command/run outcomes, HTTP counts and
  // structural text are still compared (the poll-only exclusion list is NOT widened).
  .replace(/\b(?:IN|OUT OF) (?:SPEC|CONTROL)\b/g, '<control-status>')
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
 * business-semantics differences). Round 5.2: the exclusion list was NOT widened; the
 * remaining surface is compared with per-step request counts.
 */
const BACKGROUND_POLL_PATHS = [
  /^\/api\/v1\/runs(?:\/|$)/,
  /^\/api\/v1\/sites\/[^/]+\/fabs\/[^/]+\/equipment-status$/,
];
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/g;
const maskUuid = (value) => String(value ?? '').replace(UUID_PATTERN, '<uuid>');
const maskTimestamp = (value) => String(value ?? '').replace(TIMESTAMP_PATTERN, '<ts>');
const devHeaders = () => (devKey ? { 'X-Fab-Dev-Key': devKey } : {});
const apiRequests = (browser) => {
  const requests = [];
  for (const request of browser.requests) {
    try { if (new URL(request.url).pathname.startsWith('/api/')) requests.push(request); } catch { /* ignore */ }
  }
  return requests;
};
/** Poll-only background request (real wall-clock timer driven); never a semantic signal. */
const isBackgroundPoll = (request) => {
  try {
    const url = new URL(request.url);
    return request.method === 'GET' && BACKGROUND_POLL_PATHS.some((pattern) => pattern.test(url.pathname));
  } catch { return false; }
};
/**
 * Round 5.2 / P2-01 quiescence: stability must be judged on semantic (non-poll)
 * requests. Poll-only GETs fire on real wall-clock timers (runs 1.5s, equipment
 * status 4s) and would otherwise prevent any quiet window from ever being observed.
 */
const semanticRequestCount = (browser) => apiRequests(browser).filter((request) => !isBackgroundPoll(request)).length;
/**
 * HTTP surface with request counts (P2-01 C). browser.requests is reset per scenario by
 * runMode, so every count is attributed to the current scenario; the record also carries
 * the step name. Counts are cumulative within the scenario, which makes a repeated
 * authoritative request a real difference instead of a Set collision.
 */
const countedSurface = (browser) => {
  const counts = new Map();
  for (const request of apiRequests(browser)) {
    const url = new URL(request.url);
    if (request.method === 'GET' && BACKGROUND_POLL_PATHS.some((pattern) => pattern.test(url.pathname))) continue;
    const key = request.method + ' ' + maskUuid(url.pathname);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const split = key.indexOf(' ');
      return { method: key.slice(0, split), path: key.slice(split + 1), count };
    })
    .sort((left, right) => (left.method + ' ' + left.path).localeCompare(right.method + ' ' + right.path));
};

const waitFrames = async (browser) => {
  await browser.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))', true).catch(() => undefined);
};

// P2-01 B: deterministic quiescence parameters.
const QUIET_MS = 900;
const QUIESCE_TIMEOUT_MS = 20000;
const QUIESCENCE_LOG = [];
// Set by runMode before every scenario so a barrier records its own attribution.
let ACTIVE_CONTEXT = { mode: 'init', scenario: 'init' };

/**
 * Deterministic quiescence barrier (P2-01 B). Waits until
 *   1. the set of /api/ requests issued by the page has not changed for quietMs,
 *   2. the page's DOM text produced two identical consecutive samples,
 *   3. an optional business predicate holds (for example "no run is still RUNNING"),
 * and then waits two animation frames before returning. A real wall-clock timeout is
 * recorded in QUIESCENCE_LOG (and therefore in equivalence-trace.json) and printed as a
 * warning; the caller continues with explicit evidence that the barrier timed out.
 */
const quiesce = async (browser, label, options = {}) => {
  const quietMs = options.quietMs ?? QUIET_MS;
  const timeoutMs = options.timeoutMs ?? QUIESCE_TIMEOUT_MS;
  const predicate = options.predicate ?? null;
  const started = Date.now();
  let lastApiCount = null;
  let lastDom = null;
  let lastChangeAt = Date.now();
  let stableSamples = 0;
  let predicateOk = predicate === null;
  const entry = () => ({
    mode: ACTIVE_CONTEXT.mode,
    scenario: ACTIVE_CONTEXT.scenario,
    label,
    quietMs,
    timeoutMs,
    elapsedMs: Date.now() - started,
    semanticApiRequests: lastApiCount ?? semanticRequestCount(browser),
    totalApiRequests: apiRequests(browser).length,
    predicate,
  });
  while (Date.now() - started < timeoutMs) {
    await sleep(150);
    // Stability uses semantic (non-poll) requests and the normalized DOM. Poll-only
    // requests on independent backends fire on real wall-clock timers and must not
    // prevent quiescence; digits/timestamps are normalized exactly like the comparison.
    const apiCount = semanticRequestCount(browser);
    const dom = normalize(await browser.evaluate('document.body ? document.body.innerText : ""').catch(() => ''));
    if (predicate !== null) predicateOk = Boolean(await browser.evaluate('Boolean(' + predicate + ')').catch(() => false));
    const changed = apiCount !== lastApiCount || dom !== lastDom;
    if (changed) {
      lastChangeAt = Date.now();
      stableSamples = 0;
    } else {
      stableSamples += 1;
    }
    lastApiCount = apiCount;
    lastDom = dom;
    if (predicateOk && stableSamples >= 2 && Date.now() - lastChangeAt >= quietMs) {
      await waitFrames(browser);
      const result = { ...entry(), timedOut: false };
      QUIESCENCE_LOG.push(result);
      return result;
    }
  }
  await waitFrames(browser);
  const result = { ...entry(), timedOut: true, predicateOk };
  QUIESCENCE_LOG.push(result);
  console.warn('  QUIESCE-TIMEOUT ' + result.mode + ' ' + result.scenario + ' ' + label + ' after ' + result.elapsedMs + 'ms (semanticApiRequests=' + result.semanticApiRequests + ', totalApiRequests=' + result.totalApiRequests + ', predicateOk=' + predicateOk + '); recorded in equivalence-trace.json and continuing');
  return result;
};

const snapshot = async (browser, stepName, selectors, extra = {}) => ({
  step: stepName,
  path: await browser.evaluate('location.pathname + location.search'),
  dom: normalize(await browser.bodyText()),
  business: await businessText(browser, selectors),
  http: countedSurface(browser),
  ...extra,
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
      const barrier = await quiesce(browser, 'empty-catalog', { timeoutMs: 8000 });
      record(await snapshot(browser, 'empty-catalog', ['.catalog-empty', 'main'], { quiescence: barrier }));
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
      const invalidBarrier = await quiesce(browser, 'invalid-submit', { timeoutMs: 8000 });
      record(await snapshot(browser, 'invalid-submit', ['.workbench-run-form [role="alert"]'], { quiescence: invalidBarrier }));
      await browser.setValue('.workbench-run-form input', '3');
      await browser.clickText('button', '创建并运行');
      // P2-01 B: the accepted submit has a durable side effect (a Run row and, through the
      // runs resource, poll traffic). Wait until the run is terminal AND the page/API are
      // quiet before capturing; a fixed sleep let a debounce/poll tail leak into one mode.
      const acceptedBarrier = await quiesce(browser, 'accepted-submit', {
        predicate: '!/排队中|运行中/.test(document.body.innerText)',
      });
      record(await snapshot(browser, 'accepted-submit', ['.workbench-run-form [role="alert"]', '#run-status, .run-history'], { quiescence: acceptedBarrier }));
    },
  },
  {
    id: 'bigint',
    description: 'BigInt completed-lot aggregate (moved out of component per Task 7 workaround)',
    selectors: ['.workbench-metrics, .fab-overview, .workbench-run-form'],
    async run(browser, record, webUrl) {
      await browser.navigate(webUrl + '/', 'document.querySelector(".workbench-run-form")');
      await browser.waitText('新建仿真', 25000);
      // The completed-lot aggregate is rendered from the authoritative run detail resource.
      // Wait until that resource is reflected (no AWAITING RUN placeholder), then quiesce;
      // a raw snapshot raced the run-detail fetch and produced a false compiler diff.
      const barrier = await quiesce(browser, 'bigint-visible-aggregate', {
        timeoutMs: 15000,
        predicate: "!((document.querySelector('.fab-overview')?.innerText ?? '').match(/AWAITING RUN|等待后端提交结果/))",
      });
      const fabText = await browser.evaluate('(() => { const nodes = [...document.querySelectorAll("main *")].filter((node) => node.children.length === 0 && /\\d/.test(node.textContent || "")); return nodes.slice(0, 40).map((node) => node.textContent.trim()).join(" | "); })()');
      record({ step: 'bigint-visible-aggregate', path: '/', business: normalize(String(fabText)).slice(0, 400), dom: normalize(await browser.bodyText()), http: countedSurface(browser), quiescence: barrier });
    },
  },
  {
    id: 'closure-capture',
    description: 'Stale-closure safety: selecting two tools updates the inspector to the latest',
    selectors: ['.twin-inspector #inspect-name, .original-inspector #inspect-name', 'main'],
    async run(browser, record, webUrl, siteId, fabId) {
      await browser.navigate(webUrl + twinPath(siteId, fabId), 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelectorAll("#equipment-list button[data-equipment-id]").length > 1', 25000, 'sidebar tools');
      // Wait for the scene bootstrap to finish: a loading banner ("正在初始化 WebGPU…" /
      // "正在加载原版设备模型…") otherwise leaks into one mode's DOM snapshot.
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      await browser.evaluate('document.querySelectorAll("#equipment-list button[data-equipment-id]")[0].click()');
      await browser.waitFor('document.querySelector(".twin-inspector, .original-inspector")', 20000, 'first inspector');
      const firstBarrier = await quiesce(browser, 'first-tool', { timeoutMs: 12000 });
      record(await snapshot(browser, 'first-tool', ['.twin-inspector #inspect-name, .original-inspector #inspect-name'], { quiescence: firstBarrier }));
      await browser.evaluate('document.querySelectorAll("#equipment-list button[data-equipment-id]")[1].click()');
      const secondBarrier = await quiesce(browser, 'second-tool', { timeoutMs: 12000 });
      record(await snapshot(browser, 'second-tool', ['.twin-inspector #inspect-name, .original-inspector #inspect-name'], { quiescence: secondBarrier }));
    },
  },
  {
    id: 'dynamic-import-gpu',
    description: 'Dynamic-imported WebGPU scene mounts (async import boundary)',
    selectors: ['#bottom-hud-footer', 'canvas'],
    async run(browser, record, webUrl, siteId, fabId) {
      await browser.navigate(webUrl + twinPath(siteId, fabId), 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      const barrier = await quiesce(browser, 'gpu-ready', { timeoutMs: 12000 });
      record(await snapshot(browser, 'gpu-ready', ['#bottom-hud-footer', '.twin-feed'], { quiescence: barrier }));
      const gpu = await browser.evaluate('(() => { const canvas = document.querySelector("canvas"); return { webgpu: !!canvas.getContext("webgpu"), webgl: !!canvas.getContext("webgl") }; })()');
      record({ step: 'no-webgl-fallback', path: '/', business: JSON.stringify(gpu), dom: normalize(await browser.bodyText()), http: countedSurface(browser) });
      const trace = await browser.evaluate('window.__FAB_TRACE__.map((entry) => entry.kind + ":" + entry.value).filter((value, index, all) => value !== all[index + 1]).slice(0, 20)');
      record({ step: 'gpu-lifecycle-trace', path: '/', business: JSON.stringify(trace), dom: '', http: [] });
    },
  },
  {
    id: 'atom-subscriptions',
    description: 'Effect/Atom subscription updates: DEMO source clock + feed state',
    selectors: ['#btn-sim-play', '#lbl-sim-cycle', '.twin-feed'],
    async run(browser, record, webUrl, siteId, fabId) {
      await browser.navigate(webUrl + twinPath(siteId, fabId), 'document.querySelector("main.twin-page")');
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
      const pausedBarrier = await quiesce(browser, 'demo-paused', { timeoutMs: 12000 });
      record(await snapshot(browser, 'demo-paused', ['#btn-sim-play', '#lbl-sim-cycle', '.twin-feed'], { quiescence: pausedBarrier }));
    },
  },
  {
    id: 'fab-switch',
    description: 'FAB identity switch/reload keeps one scene lifetime',
    selectors: ['#bottom-hud-footer', 'canvas'],
    async run(browser, record, webUrl, siteId, fabId) {
      await browser.navigate(webUrl + twinPath(siteId, fabId), 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready');
      const loadedBarrier = await quiesce(browser, 'fab-loaded', { timeoutMs: 12000 });
      record(await snapshot(browser, 'fab-loaded', ['#bottom-hud-footer'], { quiescence: loadedBarrier }));
      await browser.navigate(webUrl + twinPath(siteId, fabId) + '?mode=engineer', 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("canvas")', 30000, 'canvas after fab switch');
      await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', 45000, 'WebGPU ready after switch');
      const switchedBarrier = await quiesce(browser, 'fab-switched', { timeoutMs: 12000 });
      record(await snapshot(browser, 'fab-switched', ['#bottom-hud-footer'], { quiescence: switchedBarrier }));
    },
  },
  {
    id: 'external-mutable-registry',
    description: 'External mutable telemetry/AMHS registry read stays subscribed',
    selectors: ['#research-amhs-badge, #bottom-hud-footer', '.twin-feed'],
    async run(browser, record, webUrl, siteId, fabId) {
      await browser.navigate(webUrl + twinPath(siteId, fabId), 'document.querySelector("main.twin-page")');
      await browser.waitFor('document.querySelector("#bottom-hud-footer")', 30000, 'footer');
      const barrier = await quiesce(browser, 'registry-readouts', { timeoutMs: 12000 });
      record(await snapshot(browser, 'registry-readouts', ['#bottom-hud-footer', '.twin-feed', '#hud-grid-badge'], { quiescence: barrier }));
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
      // P2-01 B: the command POST triggers an authoritative reconcile/fetch tail. Wait for
      // the request set and DOM to be quiet before the surface is captured, otherwise the
      // presence of GET /api/v1/commands/{id} is a race, not a compiler difference.
      const commandBarrier = await quiesce(browser, 'projection-terminal');
      const projection = await browser.evaluate('(() => [...document.querySelectorAll("span")].map((node) => node.textContent || "").filter((text) => /rev \\d+/.test(text)).join(" | "))()');
      record({ step: 'projection-terminal', path: '/', business: normalize(projection), dom: normalize(await browser.bodyText()), http: countedSurface(browser), quiescence: commandBarrier });
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
      const barrier = await quiesce(browser, 'root-mounted', { timeoutMs: 12000 });
      const updateDepth = browser.consoleErrors.filter((entry) => /Maximum update depth|Minified React error #185/.test(entry));
      if (updateDepth.length > 0) throw new Error('React update-depth loop on the workbench root: ' + updateDepth.join(' | ').slice(0, 400));
      record({ step: 'root-mounted', path: '/', business: 'updateDepthErrors=0', dom: normalize(await browser.bodyText()), http: countedSurface(browser), quiescence: barrier });
    },
  },
];

// ---- P2-01 D: authoritative side effects fetched from each mode's own backend ----
const fetchJson = async (url) => {
  const response = await fetch(url, { headers: devHeaders() });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('GET ' + url + ' -> HTTP ' + response.status + ' ' + detail.slice(0, 200));
  }
  return response.json();
};

/** Site/FAB identity with backend-generated uuids masked (identity, not business semantics). */
const normalizeSites = (sites) => (Array.isArray(sites) ? sites : []).map((site) => ({
  site: maskUuid(site.siteId),
  code: site.code,
  templateHash: site.templateHash,
  fabs: (site.fabs ?? []).map((fab) => ({ fab: maskUuid(fab.fabId), code: fab.code })),
}));

/**
 * Command multiset: {revision, outcome, terminal} is the business state; command/site/fab
 * ids and the per-store occurredAt timestamp are identity/time, so they are masked. Sorted
 * by {revision, outcome, terminal} only.
 */
const normalizeCommandList = (list) => {
  const commands = (list?.commands ?? []).map((command) => ({
    site: maskUuid(command.siteId),
    fab: maskUuid(command.fabId),
    command: maskUuid(command.commandId),
    revision: command.revision,
    outcome: command.outcome,
    terminal: Boolean(command.terminal),
    occurredAt: maskTimestamp(command.occurredAt),
  }));
  commands.sort((left, right) =>
    left.revision - right.revision ||
    String(left.outcome).localeCompare(String(right.outcome)) ||
    Number(left.terminal) - Number(right.terminal));
  return { count: commands.length, commands };
};

/**
 * Run status multiset: status + per-FAB execution status/counts. Run ids, site ids,
 * createdAt, version and result hashes are identity/time/implementation detail and are not
 * compared here; a differing run status or lot count is a real side-effect difference.
 */
const normalizeRuns = (runs) => {
  const records = (Array.isArray(runs) ? runs : []).map((run) => ({
    status: run.status,
    executions: (run.executions ?? []).map((execution) => ({
      code: execution.code,
      status: execution.status,
      completedLots: execution.completedLots,
      totalLots: execution.totalLots,
    })),
  }));
  records.sort((left, right) =>
    String(left.status).localeCompare(String(right.status)) ||
    JSON.stringify(left.executions).localeCompare(JSON.stringify(right.executions)));
  return { count: records.length, runs: records };
};

const collectSideEffects = async (mode, modeApiUrl) => {
  try {
    const sites = await fetchJson(modeApiUrl + '/api/v1/sites');
    const site = Array.isArray(sites) ? sites[0] : null;
    const fab = site?.fabs?.[0];
    if (!site?.siteId || !fab?.fabId) throw new Error('sites response does not expose exactly one configured site/fab');
    const commandsBase = modeApiUrl + '/api/v1/sites/' + site.siteId + '/fabs/' + fab.fabId + '/commands';
    const [commandsAll, commandsActive, runs] = await Promise.all([
      fetchJson(commandsBase + '?status=all'),
      fetchJson(commandsBase + '?status=active'),
      fetchJson(modeApiUrl + '/api/v1/runs'),
    ]);
    return {
      mode,
      apiUrl: modeApiUrl,
      sites: normalizeSites(sites),
      commands: { all: normalizeCommandList(commandsAll), active: normalizeCommandList(commandsActive) },
      runs: normalizeRuns(runs),
    };
  } catch (error) {
    return { mode, apiUrl: modeApiUrl, error: error instanceof Error ? error.message : String(error) };
  }
};

const SIDE_EFFECT_FIELDS = [
  ['sites', (sideEffects) => sideEffects.sites],
  ['commands.all', (sideEffects) => sideEffects.commands?.all],
  ['commands.active', (sideEffects) => sideEffects.commands?.active],
  ['runs', (sideEffects) => sideEffects.runs],
];

const compareSideEffects = (on, off) => {
  const differences = [];
  if (on?.error || off?.error) {
    differences.push({
      scenario: 'authoritative-side-effects',
      step: 'fetch',
      kind: 'side-effect-error',
      on: on?.error ?? null,
      off: off?.error ?? null,
    });
    return differences;
  }
  for (const [field, select] of SIDE_EFFECT_FIELDS) {
    const onValue = select(on);
    const offValue = select(off);
    if (JSON.stringify(onValue) !== JSON.stringify(offValue)) {
      differences.push({ scenario: 'authoritative-side-effects', step: field, kind: 'side-effect', on: onValue, off: offValue });
    }
  }
  return differences;
};

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

const runMode = async (mode, buildResult, siteId, fabId) => {
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
      ACTIVE_CONTEXT = { mode, scenario: scenario.id };
      try {
        await scenario.run(browser, record, webUrl, siteId, fabId);
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

/**
 * LEGACY PATH (kept for P2-01): re-compare a previously recorded ON/OFF trace pair
 * offline. It never starts a browser or a backend, so it cannot prove P2-01 isolation; it
 * exists to re-evaluate an existing evidence file without re-running the harness. The
 * new counted-surface records and recorded side effects are understood when present.
 */
const compareRecorded = (reportPath) => {
  const recorded = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!recorded.traces?.on || !recorded.traces?.off) throw new Error('reuse trace is missing on/off traces: ' + reportPath);
  const sideEffects = recorded.sideEffects?.on && recorded.sideEffects?.off
    ? { on: recorded.sideEffects.on, off: recorded.sideEffects.off, equal: compareSideEffects(recorded.sideEffects.on, recorded.sideEffects.off).length === 0 }
    : null;
  const differences = compare(recorded.traces.on, recorded.traces.off);
  if (sideEffects) differences.push(...compareSideEffects(sideEffects.on, sideEffects.off));
  const scenarioFailures = recorded.scenarioFailures ?? [];
  const report = {
    ...recorded,
    generatedAt: now(),
    ...(sideEffects ? { sideEffects } : {}),
    differences,
    scenarioFailures,
    equal: differences.length === 0 && scenarioFailures.length === 0 && (recorded.auth?.unauthorizedResponses ?? 0) === 0,
    comparisonNotes: (recorded.comparisonNotes ?? []).concat([
      'LEGACY PATH: comparison re-evaluated offline from the recorded raw traces (--reuse-trace); no browser or isolated backend was started, so this re-compare cannot establish P2-01 isolation by itself.',
      'Comparison re-evaluated offline from recorded raw traces; backend-generated identity tokens (run/command ids, SHA displays) are normalized as identity, not business semantics.',
      'Poll-only GET endpoints (runs list/detail/results, equipment-status) are excluded from HTTP-surface equality because their presence is wall-clock-timer dependent; visible DOM/business text and all mutating/authoritative requests are still compared. HTTP surface records are compared as method+path+count when the recorded trace carries counts.',
      ...(sideEffects ? ['Authoritative side effects recorded with the trace were re-compared after the same identity/timestamp normalization.'] : []),
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

  if (apiUrlOn === apiUrlOff) {
    console.warn('  WARNING: --api-url-on and --api-url-off are the same endpoint; ON/OFF share one backend and are NOT isolated (P2-01 requires scripts/compiler-equivalence.ps1).');
  }
  for (const [label, modeApi] of [['on', apiUrlOn], ['off', apiUrlOff]]) {
    if (!(await waitForAuthorized(modeApi + '/api/v1/sites', devHeaders(), 15000))) {
      throw new Error('API ' + label + ' is not reachable for the equivalence run: ' + modeApi + ' (authenticated /api/v1/sites; use --api-url-on/--api-url-off for isolated fixtures)');
    }
  }
  const sites = await fetchJson(apiUrlOn + '/api/v1/sites');
  const controlSites = await fetchJson(apiUrlOff + '/api/v1/sites');
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error('equivalence run requires an authenticated sites response (got ' + JSON.stringify(sites).slice(0, 200) + '); pass --dev-key when the development API enforces X-Fab-Dev-Key');
  }
  const fixturesOn = normalizeSites(sites);
  const fixturesOff = normalizeSites(controlSites);
  // P2-01 A: both isolated backends must start from the same seeded fixture. Their Site/FAB
  // catalog is deterministic in this app, so any divergence means the run is not equivalent.
  if (JSON.stringify(fixturesOn) !== JSON.stringify(fixturesOff)) {
    throw new Error('fixtures are not identical: ON backend ' + JSON.stringify(fixturesOn).slice(0, 400) + ' vs OFF backend ' + JSON.stringify(fixturesOff).slice(0, 400));
  }
  const siteId = sites[0]?.siteId;
  const fabId = sites[0]?.fabs?.[0]?.fabId;
  if (!siteId || !fabId) throw new Error('equivalence run requires one configured Site/FAB identity');

  console.log('CORE-011: driving compiler ON build');
  const on = await runMode('on', onBuild, siteId, fabId);
  console.log('CORE-011: collecting ON authoritative side effects');
  const onSideEffects = await collectSideEffects('on', apiUrlOn);
  console.log('CORE-011: driving compiler OFF control build');
  const off = await runMode('off', offBuild, siteId, fabId);
  console.log('CORE-011: collecting OFF authoritative side effects');
  const offSideEffects = await collectSideEffects('off', apiUrlOff);

  const sideEffectDifferences = compareSideEffects(onSideEffects, offSideEffects);
  const differences = [...compare(on.trace, off.trace), ...sideEffectDifferences];
  const scenarioFailures = [...on.failures.map((failure) => ({ mode: 'on', ...failure })), ...off.failures.map((failure) => ({ mode: 'off', ...failure }))];
  const quiescenceTimeouts = QUIESCENCE_LOG.filter((entry) => entry.timedOut);
  const report = {
    generatedAt: now(),
    commit,
    provider: process.platform + '-' + process.arch,
    chrome: on.browserVersion,
    auth: { sites: sites.length, devKeyProvided: Boolean(devKey), unauthorizedResponses: [...on.authFailures, ...off.authFailures].length },
    browserVersions: { on: on.browserVersion, off: off.browserVersion },
    apiUrl: { on: apiUrlOn, off: apiUrlOff },
    fixtures: { identical: true, sites: fixturesOn },
    siteId,
    fabId,
    builds: artifactEvidence,
    scenarios: SCENARIOS.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      steps: (on.trace[scenario.id] ?? []).map((step) => step.step),
    })),
    traces: { on: on.trace, off: off.trace },
    sideEffects: { on: onSideEffects, off: offSideEffects, equal: sideEffectDifferences.length === 0 },
    quiescence: { quietMs: QUIET_MS, timeoutMs: QUIESCE_TIMEOUT_MS, timeouts: quiescenceTimeouts.length, barriers: QUIESCENCE_LOG },
    differences,
    scenarioFailures,
    equal: differences.length === 0 && scenarioFailures.length === 0 && [...on.authFailures, ...off.authFailures].length === 0,
    comparisonNotes: [
      'HTTP surface is attributed per scenario (the browser request log is reset per scenario) and recorded per step; it is compared as method+path+count, so a duplicated authoritative request is a difference instead of a Set collision.',
      'Poll-only GETs (runs list/detail/results, equipment-status) are excluded from HTTP-surface equality because their presence is wall-clock-timer dependent; every mutating/authoritative command request (including GET /api/v1/commands/{id}) is still compared. This is the only exclusion rule and P2-01 did not widen it.',
      'The mutating steps pass a deterministic quiescence barrier (semantic non-poll /api/ requests stable for ' + QUIET_MS + 'ms, two identical normalized DOM samples, an optional business predicate, then two rAF; ' + QUIESCE_TIMEOUT_MS + 'ms timeout is recorded, never silently ignored) before the HTTP surface is captured. Poll-only GETs keep firing on real wall-clock timers and are excluded from the stability signal exactly like they are excluded from the HTTP-surface equality.',
      'Authoritative side effects are fetched from each mode\'s own API after its browser run; site/fab/command/run ids are masked to <uuid>, timestamps to <ts>, the command multiset is sorted by {revision,outcome,terminal}, and the run multiset carries status/count fields only (no ids, createdAt, version or result hash).',
      'ON and OFF drive separate API processes with separate Fab__DataDirectory databases, both reset and re-seeded from the same development fixture before the run; GET /api/v1/sites is compared before driving and aborts with "fixtures are not identical" on divergence.',
      'Live FDC/SPC control status words (IN SPEC / OUT OF SPEC / IN CONTROL / OUT OF CONTROL) are normalized to <control-status> in the compared text: with isolated backends the same wall-clock window can legitimately observe different simulation phases. Persisted side effects, command/run outcomes, HTTP request counts and all other structural text remain strictly compared; this is a volatility normalization, not an exclusion of a request path.',
    ],
    limitations: [
      'P2-01: ON and OFF use isolated API processes with separate Fab__DataDirectory databases reset to the same seeded development fixture before every run; no database, idempotency record or command state is shared between the modes.',
      'P2-01: both APIs are started with the same development key and the harness aborts when GET /api/v1/sites identity differs ("fixtures are not identical").',
      'P2-01: the HTTP surface is compared with request counts per scenario step (not only as a method+path set); poll-only GET endpoints remain the only exclusion and it was not widened.',
      'P2-01: a deterministic quiescence barrier (API request set stable for ' + QUIET_MS + 'ms, two identical DOM samples, optional business predicate, two rAF; ' + QUIESCE_TIMEOUT_MS + 'ms timeout) gates the mutating scenarios; barrier timeouts are recorded in report.quiescence and are not converted into passes.',
      'Wall-clock timers are real (not frozen); comparison is on quiescent step DOM/business state and HTTP surface, so execution counts and timings may differ while semantics must not.',
      'Deterministic Math.random/crypto.randomUUID are injected; live SSE content comes from each mode\'s isolated local dev fixture (architecture supports multiple FABs; current deployment defaults to one) and is compared by DOM business text with numeric volatility and live FDC/SPC control-status vocabulary normalized. Those two normalizations are the only volatility tolerances; they do not hide compiler-semantic differences in structure, business selectors, HTTP counts or persisted side effects.',
      'GPU device-loss/recovery semantics are covered by tools/gpu_gate.mjs (CORE-012), not by the compiler equivalence trace.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'equivalence-trace.json'), JSON.stringify(report, null, 2) + '\n');
  if (!keep) {
    for (const modeBuild of [onBuild, offBuild]) fs.rmSync(modeBuild.dir, { recursive: true, force: true });
  }
  console.log('CORE-011 differences: ' + differences.length + ', scenario failures: ' + scenarioFailures.length + ', side effects equal: ' + (sideEffectDifferences.length === 0) + ', quiescence timeouts: ' + quiescenceTimeouts.length);
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
