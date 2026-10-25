import { expect, it } from 'vitest';
import {
  XRAY_SHADER_FRAGMENT,
  XRAY_SHADER_VERTEX,
  XRAY_SURFACE_GLOW,
  XRAY_SURFACE_TINT,
  xraySurfaceState,
  type XrayFilterName,
  type XraySurfaceRole,
} from '../src/xray-hologram';

const filters: XrayFilterName[] = ['all', 'upw', 'gas', 'vac', 'exhaust', 'amhs'];
const roles: XraySurfaceRole[] = ['equipment', 'floor', 'subfab', 'oht'];

it('maps every surface role and filter to the single-shader ghost/highlight state', () => {
  for (const filter of filters) {
    expect(xraySurfaceState('equipment', filter)).toEqual({ ghostAlpha: 0.16, highlight: 0, rimPower: 2.2 });
    expect(xraySurfaceState('floor', filter)).toEqual({ ghostAlpha: 0.12, highlight: 0, rimPower: 1.6 });
  }
  expect(xraySurfaceState('subfab', 'amhs')).toEqual({ ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 });
  expect(xraySurfaceState('subfab', 'all')).toEqual({ ghostAlpha: 0.55, highlight: 1, rimPower: 1.8 });
  for (const filter of ['upw', 'gas', 'vac', 'exhaust'] as const) {
    expect(xraySurfaceState('subfab', filter, true)).toEqual({ ghostAlpha: 1, highlight: 1, rimPower: 1.8 });
    expect(xraySurfaceState('subfab', filter, false)).toEqual({ ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 });
  }
  expect(xraySurfaceState('oht', 'amhs')).toEqual({ ghostAlpha: 0.9, highlight: 1, rimPower: 1.8 });
  expect(xraySurfaceState('oht', 'upw')).toEqual({ ghostAlpha: 0.25, highlight: 0, rimPower: 2.0 });
  for (const role of roles) for (const filter of filters) {
    const state = xraySurfaceState(role, filter);
    expect(state.ghostAlpha).toBeGreaterThanOrEqual(0);
    expect(state.ghostAlpha).toBeLessThanOrEqual(1);
    expect(state.highlight === 0 || state.highlight === 1).toBe(true);
  }
});

it('ships one WGSL program that drives both triangle and line surfaces', () => {
  expect(XRAY_SURFACE_TINT).toBe('#0284c7');
  expect(XRAY_SURFACE_GLOW).toBe('#38bdf8');
  for (const token of ['attribute position', 'uniform world', 'uniform worldViewProjection', 'vertexOutputs.position', 'varying vPositionW']) {
    expect(XRAY_SHADER_VERTEX).toContain(token);
  }
  for (const token of [
    'uniform xrayParams', 'uniform xrayTint', 'uniform xrayGlow', 'uniform xrayCamera',
    'uniform xrayOptions', 'uniform xrayNormalColor', 'dpdx(fragmentInputs.vPositionW)',
    'fragmentOutputs.color', 'xrayParams.z > 0.5',
  ]) {
    expect(XRAY_SHADER_FRAGMENT).toContain(token);
  }
  // The line branch is driven by the same options uniform, not by a second shader program.
  expect(XRAY_SHADER_FRAGMENT).toContain('uniforms.xrayOptions.x < 0.5');
});
