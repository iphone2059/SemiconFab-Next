// @ts-nocheck — execute with the documented connected-tab Playwright API.
import assert from 'node:assert/strict';

export async function waitForManagedRenderer(tab) {
  const ready = tab.playwright.locator('.twin-status[title^="WebGPU"]');
  const deadline = Date.now() + 30000;
  let status = '';
  while (Date.now() < deadline) {
    status = await tab.playwright.locator('.twin-status').getAttribute('title') ?? '';
    if (status.startsWith('WebGPU')) return status;
    if (/Failed to fetch|失败|不支持|不可用/i.test(status)) throw new Error(status);
    // Some connected-tab transports cap each individual wait at 3 seconds.
    // Bound the overall wait while allowing a cold GPU/dependency startup.
    try { await ready.waitFor({ state: 'visible', timeoutMs: 1000 }); } catch (error) {
      if (!/timeout|timed out|deadline/i.test(String(error))) throw error;
    }
  }
  throw new Error(`WebGPU did not become ready: ${status}`);
}

export async function runCatalogManagedStateAcceptance(tab, baseUrl = 'http://localhost:5173') {
  await tab.goto(baseUrl + '/catalog?lang=en&q=NXT%3A2050i');
  const query = await tab.playwright.locator('input[type="search"]').getAttribute('value');
  assert.equal(query, 'NXT:2050i', 'StrictMode hydration must preserve deep-link filters');
  assert.equal(new URL(await tab.url()).searchParams.get('q'), 'NXT:2050i');
  return { strictModeDeepLink: true, query };
}

export async function runManagedClockAcceptance(tab, baseUrl = 'http://localhost:5173') {
  const target = baseUrl + '/twin?mode=engineer&lang=zh-CN&modal=arch';
  if (await tab.url() === target) await tab.reload(); else await tab.goto(target);
  await tab.playwright.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click({ timeoutMs: 10000 });
  const renderer = await waitForManagedRenderer(tab);
  assert.match(renderer, /^WebGPU/, 'A canvas element or working HUD does not prove renderer readiness');
  await tab.playwright.locator('[id="sidebar-item-subfab.litho.laser.1"]').click({ timeoutMs: 10000 });
  const cycle = () => tab.playwright.locator('#lbl-sim-cycle').textContent();
  const telemetry = () => tab.playwright.locator('#telemetry-sensors-grid').innerText();
  const before = { cycle: await cycle(), telemetry: await telemetry() };
  await tab.playwright.getByText(before.cycle, { exact: true }).waitFor({ state: 'hidden', timeoutMs: 6000 });
  const after = { cycle: await cycle(), telemetry: await telemetry() };
  assert.notEqual(after.cycle, before.cycle);
  assert.notEqual(after.telemetry, before.telemetry);
  assert.match(after.telemetry, /Primary Output/);
  assert.match(after.telemetry, /kW/);
  await tab.playwright.locator('#btn-sim-play').click();
  assert.equal(await tab.playwright.locator('#btn-sim-play').getAttribute('aria-pressed'), 'false');
  return { before, after, pauseButton: true, renderer };
}
