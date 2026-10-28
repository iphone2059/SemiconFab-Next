import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ORIGINAL_TOUR_STOPS } from '../src/domain/simulation/original-tour';
import { buildTourScenario, TOUR_COUNTDOWN_MS, TOUR_FRAME_MS } from '../src/domain/simulation/tour-scenario';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/original-tour-wafer-vectors.json', import.meta.url), 'utf8'));
const firstFrame = fixture.tour.frames[0];

describe('frozen Tour scenario adapter', () => {
  it('maps every source waypoint exactly onto the controller scenario', () => {
    const scenario = buildTourScenario(ORIGINAL_TOUR_STOPS, 'en', { camera: firstFrame.camera, target: firstFrame.target });
    expect(scenario.waypoints).toEqual(fixture.tour.waypoints);
    expect(scenario.initialCamera).toEqual(firstFrame.camera);
    expect(scenario.initialTarget).toEqual(firstFrame.target);
    expect(scenario.frameMs).toBe(TOUR_FRAME_MS);
    expect(scenario.countdownIntervalMs).toBe(TOUR_COUNTDOWN_MS);
    expect(scenario.hudLanguage).toBe('en');
  });
  it('keeps the frozen level and supports the zh HUD locale', () => {
    const scenario = buildTourScenario(ORIGINAL_TOUR_STOPS, 'zh', { camera: { x: 38, y: 48, z: 58 }, target: { x: 0, y: 0, z: 0 } });
    expect(scenario.initialLevel).toBe('L1');
    expect(scenario.hudLanguage).toBe('zh-CN');
    expect(scenario.waypoints).toHaveLength(5);
    expect(scenario.waypoints[4].level).toBe('B1');
  });
});
