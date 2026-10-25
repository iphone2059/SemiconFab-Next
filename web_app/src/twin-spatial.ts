/** Frozen SemiconFab/twin.html Pascal exploded-view math. */
export const EXPLODE_EASE_PER_FRAME = 0.08;
export const EXPLODE_SETTLE_EPSILON = 0.0005;
export function clampExplodeFactor(factor: number): number {
  return Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 0;
}
export function advanceExplodeFactor(current: number, target: number): number {
  const value = clampExplodeFactor(current), destination = clampExplodeFactor(target);
  const difference = destination - value;
  return Math.abs(difference) <= EXPLODE_SETTLE_EPSILON ? destination
    : value + difference * EXPLODE_EASE_PER_FRAME;
}
export function explodedPlacement(factor: number) {
  const f = clampExplodeFactor(factor);
  return { ceilingY: f * 20, subfabY: -f * 18, linkHeight: 7 + f * 18,
    showLinks: f >= 0.01 } as const;
}
export function originalFloorOpacity(level: 'L1' | 'B1' | 'DUAL' | 'EXPLODED'): number {
  switch (level) {
    case 'B1': return 0.2;
    case 'DUAL': return 0.35;
    case 'EXPLODED': return 0.55;
    default: return 1;
  }
}
