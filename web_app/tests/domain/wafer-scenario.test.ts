import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { buildWaferScenario } from '@/domain/wafer-scenario';
import { createWaferTimeline } from '@/domain/wafer-timeline';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/original-tour-wafer-vectors.json', import.meta.url), 'utf8'));
const routes = parseWaferRoutes(JSON.parse(readFileSync(new URL('../../public/twin/routes.json', import.meta.url), 'utf8')));

it('projects all A/B/C routes onto the frozen layout without changing waypoint fields', () => {
  const scenario = buildWaferScenario(routes, 'zh');
  expect(Object.values(scenario.products).map(route => route.length)).toEqual([120, 104, 92]);
  for (const product of ['A', 'B', 'C']) {
    expect(scenario.products[product].slice(0, fixture.scenario.wafer.routeSliceSteps)).toEqual(fixture.wafer.products[product]);
  }
  expect(scenario.categoryBays).toEqual(fixture.scenario.wafer.categoryBays);
  expect(createWaferTimeline(scenario).readFrame().hud).toMatchObject({ step: '步骤 1/120', width: '0.8%', status: '晶圆流转中...' });
});

it('clears completion bookkeeping when replaying or changing products after completion', () => {
  const scenario = buildWaferScenario(routes, 'en');
  const timeline = createWaferTimeline({ ...scenario, products: { A: scenario.products.A.slice(0, 1), B: scenario.products.B.slice(0, 1) }, speed: 16 });
  for (let i = 0; i < 2; i++) timeline.step(100);
  expect(timeline.readStats().completed).toBe(true);
  timeline.replay();
  expect(timeline.readStats()).toMatchObject({ completed: false, completionTimeMs: null });
  for (let i = 0; i < 2; i++) timeline.step(100);
  expect(timeline.readStats().completionTimeMs).toBe(400);
  timeline.setProduct('B');
  expect(timeline.readStats()).toMatchObject({ completed: false, completionTimeMs: null });
});

it('updates HUD language without restarting a paused route', () => {
  const timeline = createWaferTimeline(buildWaferScenario(routes, 'zh'));
  timeline.step(100);
  timeline.togglePlay();
  const before = timeline.readFrame();
  timeline.setLanguage('en');
  const after = timeline.readFrame();
  expect(after.hud).toMatchObject({ step: 'Step 1/120', status: 'Paused' });
  expect(after.position).toEqual(before.position);
  expect(after.stepTimer).toBe(before.stepTimer);
  expect(after.playing).toBe(false);
});
