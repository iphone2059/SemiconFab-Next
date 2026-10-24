import { describe, expect, it } from 'vitest';
import { computeFabYield, scenarioStates, YIELD_SCENARIOS } from '../src/fab-yield';
import { FAB_LAYOUT } from '../src/fab-layout';

describe('cascading fab yield', () => {
  it('calculates eight module yields, bottleneck and WPM from live states', () => {
    const states = Array.from({ length: FAB_LAYOUT.length }, () => 'running');
    const result = computeFabYield(states);
    expect(result.modules).toHaveLength(8);
    expect(result.totalYield).toBeGreaterThan(0.85);
    expect(result.totalYield).toBeLessThanOrEqual(0.985);
    expect(result.wpm).toBeGreaterThan(0);
    expect(result.modules.find((module) => module.bottleneck)?.module.id).toBe(result.bottleneck.id);
    expect(result.modules.at(-1)?.cumulativeYield).toBeCloseTo(result.totalYield);
  });

  it('reproduces the six original scenario presets with deterministic overrides', () => {
    expect(YIELD_SCENARIOS).toHaveLength(6);
    const etch = YIELD_SCENARIOS.find((scenario) => scenario.id === 'etch_down')!;
    const states = scenarioStates(etch);
    expect(states.filter((state) => state === 'down')).toHaveLength(1);
    expect(computeFabYield(states, etch).modules.find((module) => module.module.id === 'etch')?.downCount).toBe(1);
    const apc = YIELD_SCENARIOS.find((scenario) => scenario.id === 'apc_upgrade')!;
    expect(computeFabYield(scenarioStates(apc), apc).totalYield).toBeGreaterThan(computeFabYield(states, etch).totalYield);
  });

  it('penalizes a down module and keeps the bottleneck deterministic', () => {
    const baseline = computeFabYield(Array.from({ length: FAB_LAYOUT.length }, () => 'running'));
    const states = Array.from({ length: FAB_LAYOUT.length }, () => 'running');
    FAB_LAYOUT.forEach((tool, index) => { if (tool.category === 'dry_etch') states[index] = 'down'; });
    const down = computeFabYield(states);
    expect(down.totalYield).toBeLessThan(baseline.totalYield);
    expect(down.modules.find((module) => module.module.id === 'etch')?.stepYield).toBeLessThan(baseline.modules.find((module) => module.module.id === 'etch')!.stepYield);
  });
});
