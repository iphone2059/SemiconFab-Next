// Single WebGPU/WGSL implementation of the X-Ray holographic effect.
//
// The frozen original (twin.html 20210-20414) swaps Three.js materials per mesh class.
// Next renders every X-Ray surface through ONE WGSL shader program: the same sources are used
// by triangle meshes (equipment, floor, subfab piping, OHT) and by the catalog wire meshes
// (LineListDrawMode). There is no alpha/colour material-mutation fallback left.
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { Scene } from '@babylonjs/core/scene';
import { Material } from '@babylonjs/core/Materials/material';
import { Vector4, type Matrix } from '@babylonjs/core/Maths/math.vector';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';

export type XrayFilterName = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';
export type XraySurfaceRole = 'equipment' | 'floor' | 'subfab' | 'oht';

export interface XraySurfaceState {
  /** Final fragment alpha in the ghost branch (0..1). */
  ghostAlpha: number;
  /** 0 = ghost glass, 1 = filter-highlighted utility. */
  highlight: number;
  /** Fresnel exponent. */
  rimPower: number;
}

export const XRAY_SURFACE_TINT = '#0284c7';
export const XRAY_SURFACE_GLOW = '#38bdf8';

/**
 * Source-derived surface modes (twin.html applyXRayGhostMaterials / applyXRayFilter):
 * equipment shells are cyan ghost glass, the cleanroom floor drops to opacity 0.12, utility piping
 * is highlighted per filter, OHT is highlighted for the AMHS filter and ghosted otherwise.
 */
export function xraySurfaceState(role: XraySurfaceRole, filter: XrayFilterName, matched = true): XraySurfaceState {
  if (role === 'equipment') return { ghostAlpha: 0.16, highlight: 0, rimPower: 2.2 };
  if (role === 'floor') return { ghostAlpha: 0.12, highlight: 0, rimPower: 1.6 };
  if (role === 'subfab') {
    if (filter === 'amhs') return { ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 };
    if (filter === 'all') return { ghostAlpha: 0.55, highlight: 1, rimPower: 1.8 };
    return matched
      ? { ghostAlpha: 1, highlight: 1, rimPower: 1.8 }
      : { ghostAlpha: 0.15, highlight: 0, rimPower: 1.8 };
  }
  return filter === 'amhs'
    ? { ghostAlpha: 0.9, highlight: 1, rimPower: 1.8 }
    : { ghostAlpha: 0.25, highlight: 0, rimPower: 2.0 };
}

export const XRAY_SHADER_VERTEX = `attribute position: vec3f;
uniform world: mat4x4f;
uniform worldViewProjection: mat4x4f;
varying vPositionW: vec3f;
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let worldPos = uniforms.world * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.vPositionW = worldPos.xyz;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}`;

export const XRAY_SHADER_FRAGMENT = `varying vPositionW: vec3f;
uniform xrayParams: vec4f;      // enabled, ghostAlpha, highlight, rimPower
uniform xrayTint: vec4f;        // ghost rgb, scan frequency
uniform xrayGlow: vec4f;        // glow rgb, scan strength
uniform xrayCamera: vec4f;      // camera xyz, time
uniform xrayOptions: vec4f;     // isLine, 0, 0, 0
uniform xrayNormalColor: vec4f; // non-X-Ray appearance (line meshes)
uniform xrayLightVP: mat4x4f;   // native static shadow light view-projection
uniform xrayShadowEnabled: f32; // 1 when the native depth texture is bound
var xrayShadowDepth: texture_depth_2d;
var xrayShadowDepthSampler: sampler_comparison;

fn xrayShadowVisibility(worldPosition: vec3f) -> f32 {
  if (uniforms.xrayShadowEnabled < 0.5) { return 1.0; }
  let clip = uniforms.xrayLightVP * vec4f(worldPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let texel = 1.0 / vec2f(textureDimensions(xrayShadowDepth));
  var visible = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      visible += textureSampleCompare(xrayShadowDepth, xrayShadowDepthSampler,
        uv + vec2f(f32(x), f32(y)) * texel, ndc.z - 0.00015);
    }
  }
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z >= 0.0 && ndc.z <= 1.0;
  return select(1.0, visible / 9.0, inside);
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  if (uniforms.xrayParams.x < 0.5) {
    fragmentOutputs.color = uniforms.xrayNormalColor;
  } else {
    let viewDir = normalize(uniforms.xrayCamera.xyz - fragmentInputs.vPositionW);
    let scan = 0.5 + 0.5 * sin(fragmentInputs.vPositionW.y * uniforms.xrayTint.w + uniforms.xrayCamera.w);
    var rim: f32 = 0.0;
    if (uniforms.xrayOptions.x < 0.5) {
      let normalW = normalize(cross(dpdx(fragmentInputs.vPositionW), dpdy(fragmentInputs.vPositionW)));
      rim = pow(1.0 - abs(dot(normalW, viewDir)), max(uniforms.xrayParams.w, 0.001));
    }
    let glow = uniforms.xrayGlow.rgb;
    let tint = uniforms.xrayTint.rgb;
    let shadow = xrayShadowVisibility(fragmentInputs.vPositionW);
    let lit = 0.35 + 0.65 * shadow;
    if (uniforms.xrayParams.z > 0.5) {
      fragmentOutputs.color = vec4f((tint * (0.45 + 0.2 * scan) + glow * (0.35 + 0.35 * rim)) * lit, 1.0);
    } else {
      let holo = (mix(tint, glow, 0.2 + 0.7 * rim) + glow * ((0.05 + 0.1 * scan) * uniforms.xrayGlow.w)) * lit;
      fragmentOutputs.color = vec4f(holo, uniforms.xrayParams.y);
    }
  }
}`;

const TINT = new Vector4(2 / 255, 132 / 255, 199 / 255, 26);
const GLOW = new Vector4(56 / 255, 189 / 255, 248 / 255, 1);
const NORMAL_LINE_COLOR = new Vector4(217 / 255, 119 / 255, 6 / 255, 0.75);

/** One WGSL program, material instances only vary uniforms and line topology. */
export class XrayMaterialPalette {
  readonly line: ShaderMaterial;
  private readonly materials = new Map<string, ShaderMaterial>();
  private readonly camera = new Vector4(0, 0, 0, 0);
  private readonly shadowBindings = new Map<ShaderMaterial, BaseTexture | undefined>();

  constructor(private readonly scene: Scene) {
    this.line = this.createMaterial('fab-xray-line', true);
    this.line.setVector4('xrayParams', new Vector4(0, 0, 0, 0));
    this.line.setVector4('xrayNormalColor', NORMAL_LINE_COLOR);
    this.line.setVector4('xrayTint', TINT);
    this.line.setVector4('xrayGlow', GLOW);
    this.line.setVector4('xrayCamera', this.camera);
    this.line.setVector4('xrayOptions', new Vector4(1, 0, 0, 0));
  }

  /** Triangle-surface material for one ghost/highlight state. */
  meshMaterial(state: XraySurfaceState): ShaderMaterial {
    const key = state.highlight + ':' + state.ghostAlpha + ':' + state.rimPower;
    let material = this.materials.get(key);
    if (!material) {
      material = this.createMaterial('fab-xray-' + this.materials.size, false);
      material.setVector4('xrayParams', new Vector4(1, state.ghostAlpha, state.highlight, state.rimPower));
      material.setVector4('xrayTint', TINT);
      material.setVector4('xrayGlow', GLOW);
      material.setVector4('xrayCamera', this.camera);
      material.setVector4('xrayOptions', new Vector4(0, 0, 0, 0));
      material.setVector4('xrayNormalColor', new Vector4(0, 0, 0, 0));
      material.disableDepthWrite = state.highlight < 0.5;
      this.materials.set(key, material);
    }
    return material;
  }

  setLineXray(enabled: boolean): void {
    this.line.setVector4('xrayParams', enabled ? new Vector4(1, 0.75, 0, 1.4) : new Vector4(0, 0, 0, 0));
  }

  /** The same hologram program samples the native static depth pass instead of running unshadowed. */
  updateShadow(matrix: Matrix, texture: BaseTexture | undefined, enabled: boolean): void {
    const materials = [this.line, ...this.materials.values()];
    for (const material of materials) {
      material.setMatrix('xrayLightVP', matrix);
      material.setFloat('xrayShadowEnabled', texture && enabled ? 1 : 0);
      if (this.shadowBindings.get(material) !== texture) {
        this.shadowBindings.set(material, texture);
        if (texture) material.setTexture('xrayShadowDepth', texture);
      }
    }
  }

  updateCamera(time: number): void {
    const activeCamera = this.scene.activeCamera;
    if (activeCamera) this.camera.set(activeCamera.globalPosition.x, activeCamera.globalPosition.y, activeCamera.globalPosition.z, time);
    else this.camera.w = time;
    this.line.setVector4('xrayCamera', this.camera);
    for (const material of this.materials.values()) material.setVector4('xrayCamera', this.camera);
  }

  dispose(): void {
    this.line.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.shadowBindings.clear();
  }

  private createMaterial(name: string, line: boolean): ShaderMaterial {
    const material = new ShaderMaterial(name, this.scene, {
      vertexSource: XRAY_SHADER_VERTEX,
      fragmentSource: XRAY_SHADER_FRAGMENT,
    }, {
      attributes: ['position'],
      uniforms: ['world', 'worldViewProjection', 'xrayParams', 'xrayTint', 'xrayGlow', 'xrayCamera', 'xrayOptions', 'xrayNormalColor', 'xrayLightVP', 'xrayShadowEnabled'],
      needAlphaBlending: true,
      shaderLanguage: ShaderLanguage.WGSL,
    });
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.alpha = 1;
    if (line) material.fillMode = Material.LineListDrawMode;
    return material;
  }
}
