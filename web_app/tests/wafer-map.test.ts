import { describe, expect, it } from 'vitest';
import { generateWaferMap, stdfSummary, theoreticalYieldModels, waferMetrics } from '../src/domain/wafer/wafer-map';

describe('WM-811K wafer map', () => {
  it('generates the original 26x26 circular projection and keeps bin totals exact', () => {
    const clean = generateWaferMap('clean', 811);
    const metrics = waferMetrics(clean);
    expect(clean.length).toBeGreaterThan(400);
    expect(metrics.total).toBe(clean.length);
    expect(Object.values(metrics.bins).reduce((sum, value) => sum + value, 0)).toBe(metrics.total);
    expect(metrics.yieldPct).toBeGreaterThan(95);
    expect(stdfSummary(clean, 'clean')).toMatchObject({ record_type: 'STDF_V4_SUMMARY' });
  });

  it('produces lower yield for a ring excursion and deterministic reseeding', () => {
    const ring = generateWaferMap('ring', 811);
    const ringMetrics = waferMetrics(ring);
    expect(ringMetrics.yieldPct).toBeLessThan(85);
    expect(generateWaferMap('ring', 811).map((die) => die.bin)).toEqual(ring.map((die) => die.bin));
  });

  it('computes Poisson, Murphy and Seeds models', () => {
    const models = theoreticalYieldModels(100, 0.15, 3);
    expect(models.poisson).toBeCloseTo(86.07, 1);
    expect(models.murphy).toBeGreaterThan(models.poisson);
    expect(models.seeds).toBeGreaterThan(models.murphy);
  });
});
