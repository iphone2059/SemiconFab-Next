import { describe, expect, it } from 'vitest';
import { advanceExplodeFactor, clampExplodeFactor, explodedPlacement, originalFloorOpacity } from '@/domain/fab-twin-spatial';

describe('frozen original exploded placement', () => {
  it('clamps factors and rejects nonfinite values', () => {
    expect(clampExplodeFactor(-1)).toBe(0);
    expect(clampExplodeFactor(2)).toBe(1);
    expect(clampExplodeFactor(NaN)).toBe(0);
  });
  it('maps source 0/50/100% hierarchy displacements', () => {
    expect(explodedPlacement(0)).toEqual({ ceilingY: 0, subfabY: -0, linkHeight: 7, showLinks: false });
    expect(explodedPlacement(0.5)).toEqual({ ceilingY: 10, subfabY: -9, linkHeight: 16, showLinks: true });
    expect(explodedPlacement(1)).toEqual({ ceilingY: 20, subfabY: -18, linkHeight: 25, showLinks: true });
  });
  it('implements source 0.08 per-frame easing and settles', () => {
    expect(advanceExplodeFactor(0, 1)).toBeCloseTo(0.08, 12);
    expect(advanceExplodeFactor(0.9998, 1)).toBe(1);
    expect(advanceExplodeFactor(1, 0)).toBeCloseTo(0.92, 12);
  });
  it('matches original source floor levels', () => {
    expect(['L1', 'B1', 'DUAL', 'EXPLODED'].map(level =>
      originalFloorOpacity(level as 'L1' | 'B1' | 'DUAL' | 'EXPLODED')
    )).toEqual([1, 0.2, 0.35, 0.55]);
  });
});
