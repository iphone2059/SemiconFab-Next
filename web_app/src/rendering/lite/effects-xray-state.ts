/**
 * Pure source-state helpers for the native Lite X-Ray hologram.
 *
 * Parity source: web_app/src/xray-hologram.ts:14-47 (surface state matrix) and
 * web_app/src/legacy-site.ts:450-458 (subfab system name matching). This module owns no
 * rendering and no engine types so the matrix can be asserted without a GPU; the effects
 * module turns these values into the shared native ShaderMaterial program
 * (`xrayParams = enabled, ghostAlpha, highlight, rimPower`).
 */

export type LiteXrayFilter = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';
export type LiteXraySurfaceRole = 'equipment' | 'floor' | 'subfab' | 'oht';

/** Frozen xray-hologram.ts:XraySurfaceState; field order is the xrayParams layout. */
export interface LiteXraySurfaceState {
  /** Final fragment alpha in the ghost branch (0..1). */
  ghostAlpha: number;
  /** 0 = ghost glass, 1 = filter-highlighted utility. */
  highlight: number;
  /** Fresnel exponent. */
  rimPower: number;
}

/**
 * Source-derived surface modes (twin.html applyXRayGhostMaterials / applyXRayFilter):
 * equipment shells are cyan ghost glass, the cleanroom floor drops to opacity 0.12, utility
 * piping is highlighted per filter, OHT is highlighted for the AMHS filter and ghosted
 * otherwise. `isActiveRole` is the frozen `matched` flag: true for the 'all' filter and for
 * subfab systems that match the active utility filter.
 */
export function liteXraySurfaceState(
  role: LiteXraySurfaceRole,
  filter: LiteXrayFilter,
  isActiveRole = true,
): LiteXraySurfaceState {
  // xray-hologram.ts:35-36.
  if (role === 'equipment') return { ghostAlpha: 0.16, highlight: 0, rimPower: 2.2 };
  if (role === 'floor') return { ghostAlpha: 0.12, highlight: 0, rimPower: 1.6 };
  if (role === 'subfab') {
    // xray-hologram.ts:37-43: AMHS always ghosts utility piping, 'all' highlights every
    // branch, each other filter highlights only the matching utility systems.
    if (filter === 'amhs') return { ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 };
    if (filter === 'all') return { ghostAlpha: 0.55, highlight: 1, rimPower: 1.8 };
    return isActiveRole
      ? { ghostAlpha: 1, highlight: 1, rimPower: 1.8 }
      : { ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 };
  }
  // xray-hologram.ts:44-46: OHT frames highlight for AMHS and ghost otherwise.
  return filter === 'amhs'
    ? { ghostAlpha: 0.9, highlight: 1, rimPower: 1.8 }
    : { ghostAlpha: 0.25, highlight: 0, rimPower: 2 };
}

/**
 * Source subfab system matcher, ported from legacy-site.ts:450-458 (isSystemMesh).
 * 'all' is never passed by the source apply path (it highlights every subfab surface);
 * like the frozen function it falls through to the exhaust rules if it ever is.
 */
export function liteXraySystemMatches(name: string, filter: LiteXrayFilter): boolean {
  const lowered = name.toLowerCase();
  if (filter === 'amhs') return lowered.includes('oht') || lowered.includes('amhs');
  if (!lowered.startsWith('subfab-')) return false;
  if (filter === 'upw') return lowered.includes('upw');
  if (filter === 'gas') return lowered.includes('gas');
  if (filter === 'vac') return lowered.includes('vac') || lowered.includes('pump') || lowered.includes('booster');
  return lowered.includes('foreline') || lowered.includes('heated') || lowered.includes('exhaust');
}
