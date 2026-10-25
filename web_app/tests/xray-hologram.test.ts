import { expect, it } from 'vitest';
import {
  createXrayHologramState,
  xrayHologramCustomCode,
  xraySurfaceState,
  XRAY_HOLOGRAM_HOOKS,
  type XrayFilterName,
  type XraySurfaceRole,
} from '../src/xray-hologram';

const filters: XrayFilterName[] = ['all', 'upw', 'gas', 'vac', 'exhaust', 'amhs'];
const roles: XraySurfaceRole[] = ['equipment', 'floor', 'subfab', 'oht'];

it('maps filter/surface roles to the source X-Ray ghost and highlight rules', () => {
  for (const filter of filters) {
    expect(xraySurfaceState('equipment', filter)).toEqual({ enabled: true, ghost: 1, highlight: 0, ghostAlpha: 0.16 });
    expect(xraySurfaceState('floor', filter)).toEqual({ enabled: true, ghost: 1, highlight: 0, ghostAlpha: 0.12 });
    expect(xraySurfaceState('oht', filter).enabled).toBe(false);
  }
  expect(xraySurfaceState('subfab', 'amhs').enabled).toBe(false);
  expect(xraySurfaceState('subfab', 'all')).toEqual({ enabled: true, ghost: 0.25, highlight: 1, ghostAlpha: 0.55 });
  for (const filter of ['upw', 'gas', 'vac', 'exhaust'] as const) {
    expect(xraySurfaceState('subfab', filter)).toEqual({ enabled: true, ghost: 0.25, highlight: 1, ghostAlpha: 0.22 });
  }
  for (const role of roles) for (const filter of filters) expect(Number.isFinite(xraySurfaceState(role, filter).ghostAlpha)).toBe(true);
});

it('keeps the hologram state contract and WGSL hooks addressable', () => {
  const state = createXrayHologramState();
  expect(state).toMatchObject({ enabled: false, ghost: 1, highlight: 0, ghostAlpha: 0.16, rimPower: 2.2, scanFrequency: 26, time: 0 });
  expect(state.tint.toHexString()).toBe('#0284C7');
  expect(state.glow.toHexString()).toBe('#38BDF8');
  expect(xrayHologramCustomCode('vertex')).toBeNull();
  const fragment = xrayHologramCustomCode('fragment');
  expect(fragment).not.toBeNull();
  expect(Object.keys(fragment!)).toEqual([XRAY_HOLOGRAM_HOOKS.alpha, XRAY_HOLOGRAM_HOOKS.color]);
  const code = fragment![XRAY_HOLOGRAM_HOOKS.color];
  for (const token of ['uniforms.xrayHologramParams', 'uniforms.xrayHologramTint', 'uniforms.xrayHologramGlow', 'uniforms.xrayHologramTime', 'normalW', 'viewDirectionW', 'fragmentInputs.vPositionW', 'finalColor']) {
    expect(code).toContain(token);
  }
});
