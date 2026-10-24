import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildWaferWaypoints, parseWaferRoutes, waferTransitPoint } from '../src/wafer-route';

it('parses the three original product routes and projects steps onto the layout', () => {
  const routes = parseWaferRoutes(JSON.parse(readFileSync(new URL('../public/twin/routes.json', import.meta.url), 'utf8')));
  expect(routes.A).toHaveLength(120);
  expect(routes.B).toHaveLength(104);
  expect(routes.C).toHaveLength(92);
  const waypoints = buildWaferWaypoints(routes.A);
  expect(waypoints).toHaveLength(120);
  expect(waypoints[0]).toMatchObject({ step: 1, toolGroup: 'TG13_WET_BENCH', category: 'wet_clean', y: 2.5 });
  expect(waypoints[0].tool).toBeDefined();
  expect(Number.isFinite(waypoints[0].x)).toBe(true);
  expect(waypoints[1].step).toBe(2);
  expect(waferTransitPoint(waypoints, 0, 0.4)).toMatchObject({ x: waypoints[0].x, z: waypoints[0].z, y: 2.5 });
  const dwell = waferTransitPoint(waypoints, 1, 0.8);
  expect(dwell.x).toBeCloseTo(waypoints[1].x);
  expect(dwell.z).toBeCloseTo(waypoints[1].z);
  const transit = waferTransitPoint(waypoints, 1, 0.35);
  expect(Number.isFinite(transit.x)).toBe(true);
});
