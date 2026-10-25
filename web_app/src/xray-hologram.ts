// WebGPU holographic X-Ray effect. The frozen original (twin.html 20210-20414) swaps
// Three.js materials for translucent/emissive ones; Next keeps the source look but renders it
// through a WGSL fragment patch instead of per-frame JS material swaps.
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { Material } from '@babylonjs/core/Materials/material';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { Color3 } from '@babylonjs/core/Maths/math.color';

export type XrayFilterName = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';
export type XraySurfaceRole = 'equipment' | 'floor' | 'subfab' | 'oht';

export interface XrayHologramState {
  enabled: boolean;
  /** 0 = keep lit surface, 1 = full holographic ghost. */
  ghost: number;
  /** 0 = ghost tint, 1 = filter-highlighted utility. */
  highlight: number;
  tint: Color3;
  glow: Color3;
  ghostAlpha: number;
  rimPower: number;
  scanFrequency: number;
  time: number;
}

export interface XraySurfaceState {
  enabled: boolean;
  ghost: number;
  highlight: number;
  ghostAlpha: number;
}

export function createXrayHologramState(): XrayHologramState {
  return {
    enabled: false,
    ghost: 1,
    highlight: 0,
    tint: Color3.FromHexString('#0284c7'),
    glow: Color3.FromHexString('#38bdf8'),
    ghostAlpha: 0.16,
    rimPower: 2.2,
    scanFrequency: 26,
    time: 0,
  };
}

/**
 * Source-derived surface modes (twin.html applyXRayGhostMaterials / applyXRayFilter):
 * equipment shells are cyan ghost glass, the cleanroom floor drops to opacity 0.12,
 * utility piping is highlighted per filter (AMHS hides it), OHT keeps the track rule.
 * The OHT rule stays on the existing alpha fallback until a WGSL line/track path exists.
 */
export function xraySurfaceState(role: XraySurfaceRole, filter: XrayFilterName): XraySurfaceState {
  if (role === 'equipment') return { enabled: true, ghost: 1, highlight: 0, ghostAlpha: 0.16 };
  if (role === 'floor') return { enabled: true, ghost: 1, highlight: 0, ghostAlpha: 0.12 };
  if (role === 'subfab') {
    if (filter === 'amhs') return { enabled: false, ghost: 0, highlight: 0, ghostAlpha: 0 };
    return filter === 'all'
      ? { enabled: true, ghost: 0.25, highlight: 1, ghostAlpha: 0.55 }
      : { enabled: true, ghost: 0.25, highlight: 1, ghostAlpha: 0.22 };
  }
  return { enabled: false, ghost: 0, highlight: 0, ghostAlpha: 0 };
}

export const XRAY_HOLOGRAM_HOOKS = {
  alpha: 'CUSTOM_FRAGMENT_UPDATE_ALPHA',
  color: 'CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR',
} as const;

export function xrayHologramCustomCode(shaderType: string): Record<string, string> | null {
  if (shaderType !== 'fragment') return null;
  return {
    [XRAY_HOLOGRAM_HOOKS.alpha]: `
if (uniforms.xrayHologramParams.x > 0.5) {
  alpha = mix(alpha, uniforms.xrayHologramTint.w, uniforms.xrayHologramParams.y);
}`,
    [XRAY_HOLOGRAM_HOOKS.color]: `
if (uniforms.xrayHologramParams.x > 0.5) {
  let xrayRim = pow(1.0 - abs(dot(normalize(normalW), normalize(viewDirectionW))), max(uniforms.xrayHologramParams.w, 0.001));
  let xrayScan = 0.5 + 0.5 * sin(fragmentInputs.vPositionW.y * uniforms.xrayHologramGlow.w + uniforms.xrayHologramTime.x);
  if (uniforms.xrayHologramParams.z > 0.5) {
    finalColor.rgb += uniforms.xrayHologramGlow.rgb * (0.35 + 0.25 * xrayScan);
    finalColor.a = 1.0;
  } else {
    let xrayGhost = uniforms.xrayHologramTint.rgb;
    let xrayGlow = uniforms.xrayHologramGlow.rgb;
    let xrayHolo = mix(xrayGhost, xrayGlow, 0.25 + 0.65 * xrayRim) + xrayGlow * ((0.06 + 0.1 * xrayScan) * uniforms.xrayHologramParams.y);
    finalColor.rgb = mix(finalColor.rgb, xrayHolo, uniforms.xrayHologramParams.y);
    finalColor.a = mix(finalColor.a, uniforms.xrayHologramTint.w, uniforms.xrayHologramParams.y);
  }
}`,
  };
}

export class XrayHologramMaterial extends MaterialPluginBase {
  constructor(material: Material, private readonly state: XrayHologramState) {
    super(material, 'FABXrayHologram', 200, {}, true, true);
  }
  override isCompatible(language: ShaderLanguage) { return language === ShaderLanguage.WGSL; }
  override getUniforms() {
    return {
      ubo: [
        { name: 'xrayHologramParams', size: 4, type: 'vec4' },
        { name: 'xrayHologramTint', size: 4, type: 'vec4' },
        { name: 'xrayHologramGlow', size: 4, type: 'vec4' },
        { name: 'xrayHologramTime', size: 4, type: 'vec4' },
      ],
    };
  }
  override bindForSubMesh(buffer: UniformBuffer) {
    const state = this.state;
    buffer.updateFloat4('xrayHologramParams', state.enabled ? 1 : 0, state.ghost, state.highlight, state.rimPower);
    buffer.updateFloat4('xrayHologramTint', state.tint.r, state.tint.g, state.tint.b, state.ghostAlpha);
    buffer.updateFloat4('xrayHologramGlow', state.glow.r, state.glow.g, state.glow.b, state.scanFrequency);
    buffer.updateFloat4('xrayHologramTime', state.time, 0, 0, 0);
  }
  override getCustomCode(type: string) { return xrayHologramCustomCode(type); }
}
