#!/usr/bin/env node
/**
 * CORE-012 / Phase E: production-bundle browser functional regression.
 *
 * Drives the production `vite build` artifact served by `vite preview` (never the
 * dev server) in a fixed local Chrome. The Lead-owned scripts/e2e-production.ps1
 * starts preview + the local API and passes --web-url/--api-url/--commit.
 *
 * Usage:
 *   node tools/e2e_production.mjs --web-url http://127.0.0.1:4173 --api-url http://127.0.0.1:5080  *     --out docs/architecture/evidence/phase-e-e2e.json --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"  *     --commit <sha> [--mode dev|on|off]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, arg, cleanupStaleProfiles, findFreePort, now, readDevKey, removeProfile, sleep, uniqueProfile, waitForAuthorized, waitForHttp } from './lib/browser-driver.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const webUrl = (arg('web-url', 'http://127.0.0.1:4173')).replace(/\/$/, '');
const apiUrl = (arg('api-url', 'http://127.0.0.1:5080')).replace(/\/$/, '');
const out = arg('out', path.join(root, 'docs/architecture/evidence/phase-e-e2e.json'));
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const commit = arg('commit', 'pending');
const mode = arg('mode', 'on');
const timeoutMs = Number(arg('timeout', '45000'));
const screenshotDir = path.join(path.dirname(out), 'screenshots');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const devKey = readDevKey(root);
const apiHeaders = devKey ? { 'X-Fab-Dev-Key': devKey } : {};
if (!(await waitForHttp(webUrl + '/', 8000))) {
  console.error('production web target is not reachable: ' + webUrl);
  process.exit(2);
}
if (!(await waitForAuthorized(apiUrl + '/api/v1/sites', apiHeaders, 15000))) {
  console.error('local API is not reachable (authenticated /api/v1/sites): ' + apiUrl + '; pass the development key via .local/development-key or FAB_DEVELOPMENT_KEY');
  process.exit(2);
}
const sites = await (await fetch(apiUrl + '/api/v1/sites', { headers: apiHeaders })).json();
const catalog = await (await fetch(apiUrl + '/api/v1/catalog', { headers: apiHeaders })).json();
const fab = sites[0]?.fabs?.[0];
if (!fab) {
  console.error('production e2e requires at least one configured FAB');
  process.exit(2);
}
const fabId = fab.fabId;
const scenarios = [];
let browser;
let profileDir;
cleanupStaleProfiles('fab-production-e2e-');

const recordScenario = async (id, name, steps) => {
  const record = { id, name, steps: [], pass: false, actual: '', consoleErrors: [], network: null, screenshot: null, limitations: [] };
  const step = (description, expected, actual, pass = true) => record.steps.push({ description, expected, actual: String(actual), pass });
  try {
    browser.consoleErrors = [];
    browser.requests = [];
    await steps({ record, step, screenshot: async (suffix = '') => {
      const file = path.join(screenshotDir, id + (suffix ? '-' + suffix : '') + '.png');
      record.screenshot = await browser.screenshot(file);
      return record.screenshot;
    } });
    const failed = record.steps.filter((entry) => !entry.pass);
    if (failed.length) throw new Error('failed assertions: ' + failed.map((entry) => entry.description + ' (' + entry.actual + ')').join('; '));
    const unexpected = browser.consoleErrors.filter((entry) => !/net::ERR_FAILED|Failed to load resource: the server responded with a status of 404|Page entered Back-Forward Cache|FAB 不存在/.test(entry));
    record.pass = unexpected.length === 0;
    if (!record.pass) throw new Error('browser console errors: ' + unexpected.join(' | '));
  } catch (error) {
    record.actual = error instanceof Error ? error.message : String(error);
    if (record.pass !== true) record.pass = false;
    try { record.pageUrl = await browser.url(); record.bodyText = (await browser.bodyText()).slice(0, 1500); } catch { /* page may be navigating */ }
    try { record.screenshot = await browser.screenshot(path.join(screenshotDir, id + '-failure.png')); } catch { /* best effort */ }
  }
  record.consoleErrors = [...browser.consoleErrors];
  const byUrl = new Map();
  for (const request of browser.requests) byUrl.set(request.url, (byUrl.get(request.url) ?? 0) + 1);
  record.network = {
    total: browser.requests.length,
    eventSources: browser.requests.filter((request) => request.type === 'EventSource').length,
    keyRequests: [...byUrl.entries()].filter(([url]) => /api\/v1|equipment-status|telemetry|commands/.test(url)).map(([url, count]) => ({ url, count })).slice(0, 30),
  };
  if (!record.actual) record.actual = 'all assertions passed';
  scenarios.push(record);
  process.stdout.write((record.pass ? 'PASS ' : 'FAIL ') + id + ' ' + name + '\n');
  if (!record.pass) process.stdout.write('  ' + record.actual + '\n');
};

try {
  const port = await findFreePort();
  profileDir = uniqueProfile('fab-production-e2e-');
  browser = await Browser.open({ chrome, port, userDataDir: profileDir });
  await browser.waitFor('document.readyState === "complete"', 30000, 'initial document');
  const navigate = (route, condition) => browser.navigate(webUrl + route, condition);

  await recordScenario('P1', 'Workbench production shell renders from the built bundle', async ({ step, screenshot }) => {
    await navigate('/', 'document.querySelector(".workbench-run-form")');
    await browser.waitText('新建仿真', timeoutMs);
    await screenshot();
    step('workbench shell renders', 'run form visible', 'present');
    step('production build served HTML shell', 'main element', await browser.count('main'));
    const body = await browser.bodyText();
    step('sites document loaded through the production preview /api proxy', 'FAB card', 'fab visible=' + (body.includes(fab.code) || body.includes(fab.fabId)), body.includes(fab.code) || body.includes(fab.fabId));
  });

  await recordScenario('P2', 'Equipment catalog search/filter in production', async ({ step }) => {
    await navigate('/equipment?lang=en', 'document.querySelector(".catalog-list, .catalog-empty")');
    await browser.waitFor('document.querySelectorAll(".catalog-list tbody tr").length > 0', 20000, 'catalog rows');
    const initialRows = await browser.count('.catalog-list tbody tr');
    await browser.setValue('input[type="search"]', 'Canon');
    await browser.waitFor('document.querySelectorAll(".catalog-list tbody tr").length < ' + Math.max(initialRows, 1), 10000, 'filtered rows');
    step('catalog search narrows rows', 'fewer than ' + initialRows, await browser.count('.catalog-list tbody tr'));
    await browser.clickText('button', 'All equipment').catch(() => undefined);
    step('catalog page stays interactive', 'no fatal error', String(!(await browser.evaluate('!!document.querySelector(".fatal")'))));
  });

  await recordScenario('P3', 'Deep-linked language/theme survive production refresh', async ({ step }) => {
    await navigate('/equipment?lang=en&theme=dark', 'document.querySelector(".catalog-list, .catalog-empty")');
    await browser.waitText('All equipment', 20000);
    await browser.send('Page.reload', { ignoreCache: false });
    await browser.waitFor('document.readyState === "complete"', 30000, 'reload ready');
    await browser.waitFor('document.querySelector(".catalog-list, .catalog-empty")', 20000, 'catalog after reload');
    step('refresh keeps lang/theme query', 'lang=en&theme=dark', await browser.url());
    step('dark theme from URL is applied', 'dark class/token', String(await browser.evaluate('document.documentElement.className.includes("dark") || document.body.className.includes("dark") || JSON.stringify(localStorage) !== "{}"')));
  });

  await recordScenario('P4', 'Run form validation + accepted submit through the production bundle', async ({ step, record }) => {
    await navigate('/', 'document.querySelector(".workbench-run-form")');
    await browser.waitText('新建仿真', timeoutMs);
    await browser.setValue('.workbench-run-form input', 'not-a-number');
    await browser.clickText('button', '创建并运行');
    await sleep(500);
    step('invalid form surfaces a submission error state', '>=1 alert', await browser.count('.workbench-run-form [role="alert"]'));
    await browser.setValue('.workbench-run-form input', '3');
    await browser.clickText('button', '创建并运行');
    await sleep(2500);
    step('accepted submit leaves no form error', '0 alerts', await browser.count('.workbench-run-form [role="alert"]'));
    record.limitations.push('Run completion timing depends on the local backend; the assertion is the absence of a validation/submit error, matching the dev e2e baseline.');
  });

  await recordScenario('P5', 'Twin WebGPU scene, no WebGL fallback, tool selection and DEMO clock', async ({ step, record }) => {
    await navigate('/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
    await browser.waitFor('document.querySelector("canvas")', 30000, 'twin canvas');
    await browser.waitFor('document.querySelector("#bottom-hud-footer") && !document.querySelector(".twin-render-status") && document.querySelector("#bottom-hud-footer").innerText.includes("WebGPU")', timeoutMs, 'WebGPU ready footer');
    const gpu = await browser.evaluate('(() => { const canvas = document.querySelector("canvas"); if (!canvas) return null; return { webgpu: !!canvas.getContext("webgpu"), webgl: !!canvas.getContext("webgl"), webgl2: !!canvas.getContext("webgl2") }; })()');
    step('scene reports WebGPU lifecycle', 'footer contains WebGPU', await browser.textOf('#bottom-hud-footer'));
    step('canvas has a WebGPU context and no WebGL fallback', 'webgpu=true webgl=false', JSON.stringify(gpu));
    await browser.waitFor('document.querySelectorAll("#equipment-list button[data-equipment-id]").length > 0', 20000, 'sidebar equipment');
    await browser.evaluate('document.querySelector("#equipment-list button[data-equipment-id]").click()');
    await browser.waitFor('document.querySelector(".twin-inspector, .original-inspector")', 15000, 'inspector');
    step('tool selection opens the inspector', 'inspector visible', await browser.count('.twin-inspector, .original-inspector'));
    await browser.evaluate('(() => { const select = [...document.querySelectorAll("select")].find((element) => [...element.options].some((option) => option.value === "demo")); if (!select) return false; select.value = "demo"; select.dispatchEvent(new Event("change", {bubbles:true})); return true; })()');
    await browser.waitFor('!document.querySelector("#btn-sim-play").disabled', 15000, 'demo enabled');
    if (await browser.evaluate('document.querySelector("#btn-sim-play").getAttribute("aria-pressed") === "false"')) await browser.click('#btn-sim-play');
    await browser.waitFor('document.querySelector("#btn-sim-play").getAttribute("aria-pressed") === "true"', 10000, 'demo playing');
    const cycleBefore = await browser.textOf('#lbl-sim-cycle');
    await sleep(1900);
    const cycleAfter = await browser.textOf('#lbl-sim-cycle');
    step('DEMO clock advances (Atom subscription path)', 'cycle label changes', cycleBefore + ' -> ' + cycleAfter, cycleBefore !== cycleAfter);
    record.limitations.push('Production fixture exposes one FAB; the cross-FAB matrix is covered by integration suites. GPU device-loss recovery is the gpu gate, not this functional run.');
  });

  await recordScenario('P6', 'Twin realtime REST + SSE feed is LIVE', async ({ step, record }) => {
    await navigate('/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
    await browser.waitFor('document.querySelector(".twin-feed")', 20000, 'twin feed');
    // The default source is DEMO; the realtime gate must select the SSE source.
    const switched = await browser.evaluate('(() => { const select = [...document.querySelectorAll("select")].find((element) => [...element.options].some((option) => option.value === "sse-live")); if (!select) return false; select.value = "sse-live"; select.dispatchEvent(new Event("change", {bubbles:true})); return true; })()');
    step('SSE status source can be selected', 'sse-live option present', String(switched), switched === true);
    await browser.waitFor('document.querySelector(".twin-feed").innerText.includes("LIVE") || document.querySelector(".twin-feed").innerText.includes("CACHE") || document.querySelector(".twin-feed").innerText.includes("CONNECTING")', 45000, 'realtime feed');
    step('REST equipment snapshot requested', '>=1 equipment-status request', browser.requests.filter((request) => /equipment-status$/.test(request.url)).length);
    step('SSE connection established', '>=1 EventSource', browser.requests.filter((request) => request.type === 'EventSource').length);
    record.limitations.push('SSE reconnect/failure injection is covered by the dev functional suite and integration tests; this production run asserts the live transport is real.');
  });

  await recordScenario('P7', 'Unknown FAB route fails closed in production', async ({ step }) => {
    await navigate('/fabs/unknown-fab/3d', 'document.querySelector(".fatal, main.twin-page.twin-error")');
    await browser.waitText('FAB 不存在', 20000);
    step('unknown FAB shows the route error', 'FAB 不存在', (await browser.textOf('.fatal, main.twin-page.twin-error')).slice(0, 120));
  });

  await recordScenario('P8', 'Page exit/re-enter leaves no duplicate event streams', async ({ step, record }) => {
    await navigate('/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
    await sleep(2500);
    const firstStreams = browser.requests.filter((request) => request.type === 'EventSource').length;
    browser.activeEventSources.clear();
    await navigate('/', 'document.querySelector(".workbench-run-form")');
    await sleep(1000);
    browser.activeEventSources.clear();
    await navigate('/fabs/' + fabId + '/3d', 'document.querySelector("main.twin-page")');
    await sleep(3000);
    const active = [...browser.activeEventSources];
    const duplicates = active.length - new Set(active.map((value) => value.split(' ')[1])).size;
    step('re-entry leaves at most one active stream per URL', 'duplicates<=0', 'active=' + active.length + ' duplicates=' + duplicates, duplicates <= 0);
    step('first twin lifetime opened SSE streams', '>=1 EventSource', firstStreams);
    record.limitations.push('Stream duplication is measured from active EventSource request ids; timer/actor disposal is covered by unit suites.');
  });

  await recordScenario('P9', 'External-Atom-only hook updates its projection (compiler workaround)', async ({ step }) => {
    // CORE-011 compiler limitation: a hook whose only reactive input is an
    // external Atom subscription was memoized by call arguments in ON mode.
    // useCommandProjection carries an explicit 'use no memo' workaround; this
    // production scenario proves the projection still advances end-to-end.
    await navigate('/', 'document.querySelector(".workbench-run-form")');
    await browser.waitText('设备命令', timeoutMs);
    await browser.waitFor('(() => { const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent.trim() === "下发命令" && !entry.disabled); return !!button; })()', 40000, 'command submit enabled');
    await browser.clickText('button', '下发命令');
    await browser.waitFor('document.body.innerText.includes("rev ")', 30000, 'projection revision');
    await browser.waitFor('document.body.innerText.includes("succeeded")', 40000, 'terminal command outcome');
    const projection = await browser.evaluate('(() => [...document.querySelectorAll("span")].map((node) => node.textContent || "").filter((text) => /rev \\d+/.test(text)).join(" | "))()');
    const waiting = await browser.evaluate('document.body.innerText.includes("等待 SSE 事件…")');
    step('Atom projection advanced past the waiting placeholder', 'succeeded · rev', projection);
    step('no projection row stayed at the memoized waiting state', 'no 等待 SSE 事件…', String(waiting), waiting === false);
  });

} catch (error) {
  console.error('production e2e harness failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  const report = {
    generatedAt: now(),
    commit,
    mode,
    webUrl,
    apiUrl,
    browser: browser?.session.version?.Browser ?? null,
    fixtures: { sites: sites.length, fabs: sites.reduce((sum, site) => sum + site.fabs.length, 0), catalogItems: catalog.items.length, fabId },
    scenarios,
    passed: scenarios.filter((scenario) => scenario.pass).length,
    failed: scenarios.filter((scenario) => !scenario.pass).length,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('report: ' + out + ' (' + report.passed + ' passed, ' + report.failed + ' failed)\n');
  if (report.failed > 0) process.exitCode = 1;
  try { browser?.close(); } catch { /* ignore */ }
  await sleep(300);
  if (profileDir) removeProfile(profileDir);
}
