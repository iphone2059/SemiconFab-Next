// @ts-nocheck — execute with the documented connected-tab Playwright API.
import assert from 'node:assert/strict';

export async function runCatalogManagedStateAcceptance(tab, baseUrl = 'http://localhost:5173') {
  await tab.goto(baseUrl + '/catalog?lang=en&q=NXT%3A2050i');
  const query = await tab.playwright.locator('input[type="search"]').getAttribute('value');
  assert.equal(query, 'NXT:2050i', 'StrictMode hydration must preserve deep-link filters');
  assert.equal(new URL(await tab.url()).searchParams.get('q'), 'NXT:2050i');
  return { strictModeDeepLink: true, query };
}

export async function runManagedClockAcceptance(tab, baseUrl = 'http://localhost:5173') {
  await tab.goto(baseUrl + '/twin?mode=engineer&lang=zh-CN&modal=arch');
  await tab.playwright.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click({ timeoutMs: 10000 });
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
  return { before, after, pauseButton: true };
}
