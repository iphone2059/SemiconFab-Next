/**
 * Frozen X-Ray WGSL program and its structured uniform / sampler / attribute contract.
 *
 * Port of web_app/src/xray-hologram.ts:60-201 (one WGSL program, per-state materials)
 * plus the native CSM receiver maths used by Lite's own standard/PBR receivers
 * (csm-shadow-fragment-core). The palette owner (./xray.ts) creates every material from
 * this exact contract, so uniform declaration order/types and the WGSL that reads them
 * cannot drift apart; a malformed contract fails in `createShaderMaterial` at assembly
 * time instead of rendering a silently broken hologram.
 *
 * ONE program is shared by triangle meshes and catalog line meshes (catalog line meshes
 * are the frozen '-wire' meshes, legacy-site.ts:463). `getFinalWorld(input)` is Lite's
 * public instancing-aware world helper (enableShaderMaterialInstanceWorld), so the same
 * source also serves thin-instanced equipment/subfab batches.
 */
import type { ShaderAttributeName, ShaderSamplerOption, ShaderUniformOption } from '@babylonjs/lite';
import { CUT_PLANE_UNIFORM } from './cut';

// Frozen palette constants, xray-hologram.ts:114-116.
export const XRAY_TINT: readonly [number, number, number, number] = [2 / 255, 132 / 255, 199 / 255, 26];
export const XRAY_GLOW: readonly [number, number, number, number] = [56 / 255, 189 / 255, 248 / 255, 1];
export const XRAY_NORMAL_LINE_COLOR: readonly [number, number, number, number] = [217 / 255, 119 / 255, 6 / 255, 0.75];
// xray-hologram.ts:154 setLineXray(true).
export const XRAY_LINE_PARAMS: readonly [number, number, number, number] = [1, 0.75, 0, 1.4];
export const XRAY_ZERO_PARAMS: readonly [number, number, number, number] = [0, 0, 0, 0];
// Frozen source response: shadowed surfaces retain a .35 legibility floor, unshadowed
// surfaces retain their original color. Color encoding belongs to the output path, not
// this light response.
export const XRAY_LIT_FLOOR = 0.35;

export const XRAY_VERTEX_SOURCE = `struct XrayVertexOutput{
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
};
@vertex
fn mainVertex(input: VertexInput) -> XrayVertexOutput {
  var output: XrayVertexOutput;
  let finalWorld = getFinalWorld(input);
  let worldPosition = finalWorld * vec4<f32>(input.position, 1.0);
  output.worldPosition = worldPosition.xyz;
  output.position = shaderSystem.viewProjection * worldPosition;
  return output;
}`;

// Port of xray-hologram.ts:60-112 plus the native CSM receiver maths used by Lite's own
// standard/PBR receivers (csm-shadow-fragment-core): cascade selection by view-space Z,
// 3x3 shadow-map PCF, darkness and frustum-edge falloff.
export const XRAY_FRAGMENT_SOURCE = `struct XrayVertexOutput{
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
};
fn xrayDisplayColor(rgb: vec3<f32>, alpha: f32) -> vec4<f32> {
  // Preserve the frozen opaque ShaderMaterial response through transmission's trailing encode.
  // Ghosts still blend in the linear target, so their encoded-space alpha composition remains
  // a separate parity gap; see LITE-GAP-COMPOSITING-001.md and the GPU ghost probe.
  let display = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(select(display, pow(display, vec3<f32>(2.2)), scene.vImageInfos.w < 0.0), alpha);
}
fn xrayCsmFallOff(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
  let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
  return mix(value, 1.0, mask);
}
fn xrayDepthCompare(uv: vec2<f32>, layer: i32, depthRef: f32) -> f32 {
  // CSM receiver: 2-layer depth32float array sampled with its comparison sampler, exactly like
  // Lite's own PBR/Standard CSM receivers (shadow-fragment-pcf / csm-shadow-fragment-core).
  return textureSampleCompareLevel(xrayDepth, xrayDepthSampler, uv, layer, depthRef);
}
fn xrayCsmSampleWith(cascadeTransform: mat4x4<f32>, layer: i32, worldPosition: vec4<f32>) -> f32 {
  let posFromLight = cascadeTransform * worldPosition;
  let clipSpace = posFromLight.xyz / posFromLight.w;
  let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
  let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);
  let mapSz = shaderUniforms.xrayShadowsInfo.y;
  let invMapSz = shaderUniforms.xrayShadowsInfo.z;
  var tc = uv * mapSz + 0.5;
  let st = fract(tc);
  let base = (floor(tc) - 0.5) * invMapSz;
  let uvw0 = 4.0 - 3.0 * st;
  let uvw1 = vec2<f32>(7.0);
  let uvw2 = 1.0 + 3.0 * st;
  let u = vec3<f32>((3.0 - 2.0 * st.x) / uvw0.x - 2.0, (3.0 + st.x) / uvw1.x, st.x / uvw2.x + 2.0) * invMapSz;
  let v = vec3<f32>((3.0 - 2.0 * st.y) / uvw0.y - 2.0, (3.0 + st.y) / uvw1.y, st.y / uvw2.y + 2.0) * invMapSz;
  var shadow = 0.0;
  shadow += uvw0.x * uvw0.y * xrayDepthCompare(base + vec2<f32>(u[0], v[0]), layer, depthRef);
  shadow += uvw1.x * uvw0.y * xrayDepthCompare(base + vec2<f32>(u[1], v[0]), layer, depthRef);
  shadow += uvw2.x * uvw0.y * xrayDepthCompare(base + vec2<f32>(u[2], v[0]), layer, depthRef);
  shadow += uvw0.x * uvw1.y * xrayDepthCompare(base + vec2<f32>(u[0], v[1]), layer, depthRef);
  shadow += uvw1.x * uvw1.y * xrayDepthCompare(base + vec2<f32>(u[1], v[1]), layer, depthRef);
  shadow += uvw2.x * uvw1.y * xrayDepthCompare(base + vec2<f32>(u[2], v[1]), layer, depthRef);
  shadow += uvw0.x * uvw2.y * xrayDepthCompare(base + vec2<f32>(u[0], v[2]), layer, depthRef);
  shadow += uvw1.x * uvw2.y * xrayDepthCompare(base + vec2<f32>(u[1], v[2]), layer, depthRef);
  shadow += uvw2.x * uvw2.y * xrayDepthCompare(base + vec2<f32>(u[2], v[2]), layer, depthRef);
  shadow /= 144.0;
  shadow = mix(shaderUniforms.xrayShadowsInfo.x, 1.0, shadow);
  return xrayCsmFallOff(shadow, clipSpace.xy, shaderUniforms.xrayShadowsInfo.w);
}
fn xrayCsmSample(layer: i32, worldPosition: vec4<f32>) -> f32 {
  if (layer == 0) { return xrayCsmSampleWith(shaderUniforms.xrayCascade0, layer, worldPosition); }
  if (layer == 1) { return xrayCsmSampleWith(shaderUniforms.xrayCascade1, layer, worldPosition); }
  if (layer == 2) { return xrayCsmSampleWith(shaderUniforms.xrayCascade2, layer, worldPosition); }
  return xrayCsmSampleWith(shaderUniforms.xrayCascade3, layer, worldPosition);
}
fn xrayCsmShadow(worldPosition: vec4<f32>, viewZ: f32) -> f32 {
  let nCascades = i32(shaderUniforms.xrayCsmParams.x);
  var idx = -1;
  var diff = 0.0;
  for (var i = 0; i < nCascades; i = i + 1) {
    diff = shaderUniforms.xrayViewFrustumZ[i] - viewZ;
    if (diff >= 0.0) { idx = i; break; }
  }
  if (idx < 0) { idx = nCascades - 1; }
  var shadow = xrayCsmSample(idx, worldPosition);
  let frustumLength = shaderUniforms.xrayFrustumLengths[idx];
  let diffRatio = clamp(diff / frustumLength, 0.0, 1.0) * shaderUniforms.xrayCsmParams.y;
  if (idx < nCascades - 1 && diffRatio < 1.0) {
    let nextShadow = xrayCsmSample(idx + 1, worldPosition);
    shadow = mix(nextShadow, shadow, diffRatio);
  }
  return shadow;
}
@fragment
fn mainFragment(input: XrayVertexOutput) -> @location(0) vec4<f32> {
  // Section cut: every effects shader owns the same clamped plane copy.
  if (dot(vec4<f32>(input.worldPosition, 1.0), shaderUniforms.cutPlane) > 0.0) { discard; }
  if (shaderUniforms.xrayParams.x < 0.5) {
    return xrayDisplayColor(shaderUniforms.xrayNormalColor.rgb, shaderUniforms.xrayNormalColor.a);
  }
  let viewDir = normalize(shaderSystem.cameraPosition - input.worldPosition);
  let scan = 0.5 + 0.5 * sin(input.worldPosition.y * shaderUniforms.xrayTint.w + shaderUniforms.xrayTime);
  var rim = 0.0;
  if (shaderUniforms.xrayOptions.x < 0.5) {
    let normalW = normalize(cross(dpdx(input.worldPosition), dpdy(input.worldPosition)));
    rim = pow(1.0 - abs(dot(normalW, viewDir)), max(shaderUniforms.xrayParams.w, 0.001));
  }
  let glow = shaderUniforms.xrayGlow.rgb;
  let tint = shaderUniforms.xrayTint.rgb;
  var shadow = 1.0;
  if (shaderUniforms.xrayShadowEnabled >= 0.5) {
    shadow = xrayCsmShadow(vec4<f32>(input.worldPosition, 1.0), (shaderSystem.view * vec4<f32>(input.worldPosition, 1.0)).z);
  }
  let lit = ${XRAY_LIT_FLOOR.toFixed(2)} + (1.0 - ${XRAY_LIT_FLOOR.toFixed(2)}) * shadow;
  if (shaderUniforms.xrayParams.z > 0.5) {
    return xrayDisplayColor((tint * (0.45 + 0.2 * scan) + glow * (0.35 + 0.35 * rim)) * lit, 1.0);
  }
  let holo = (mix(tint, glow, 0.2 + 0.7 * rim) + glow * ((0.05 + 0.1 * scan) * shaderUniforms.xrayGlow.w)) * lit;
  return xrayDisplayColor(holo, shaderUniforms.xrayParams.y);
}`;

/** Vertex attributes the shared program consumes (thin-instance data is injected by Lite). */
export const XRAY_ATTRIBUTES = ['position'] as const;

/**
 * Structured uniform contract: the exact declarations, in the exact order every palette
 * material was validated against in the frozen effects module. System uniforms are named
 * by Lite; the rest are the frozen xray-hologram.ts uniform block.
 */
export const XRAY_UNIFORMS = [
  'world', 'view', 'viewProjection', 'cameraPosition',
  { name: 'xrayParams', type: 'vec4<f32>' },
  { name: 'xrayTint', type: 'vec4<f32>' },
  { name: 'xrayGlow', type: 'vec4<f32>' },
  { name: 'xrayOptions', type: 'vec4<f32>' },
  { name: 'xrayNormalColor', type: 'vec4<f32>' },
  { name: 'xrayTime', type: 'f32' },
  { ...CUT_PLANE_UNIFORM },
  { name: 'xrayShadowEnabled', type: 'f32' },
  { name: 'xrayCascade0', type: 'mat4x4<f32>' },
  { name: 'xrayCascade1', type: 'mat4x4<f32>' },
  { name: 'xrayCascade2', type: 'mat4x4<f32>' },
  { name: 'xrayCascade3', type: 'mat4x4<f32>' },
  { name: 'xrayViewFrustumZ', type: 'vec4<f32>' },
  { name: 'xrayFrustumLengths', type: 'vec4<f32>' },
  { name: 'xrayShadowsInfo', type: 'vec4<f32>' },
  { name: 'xrayCsmParams', type: 'vec4<f32>' },
] as const satisfies readonly ShaderUniformOption[];

// Product composition borrows the live 2-layer CSM receiver; the palette casts through a
// depth-only Standard material so the caster pass never binds a sampler on the writable depth map.
export const XRAY_SAMPLERS = [
  { name: 'xrayDepth', sampleType: 'depth', viewDimension: '2d-array', comparison: true },
] as const satisfies readonly ShaderSamplerOption[];

/** Precise structured exchange contract between this frozen shader port and the X-Ray owner. */
export interface LiteXrayShaderProgram {
  readonly vertexSource: string;
  readonly fragmentSource: string;
  readonly attributes: readonly ShaderAttributeName[];
  readonly uniforms: readonly ShaderUniformOption[];
  readonly samplers: readonly ShaderSamplerOption[];
}

/** Frozen product program: X-Ray palette triangles and catalog line meshes share it. */
export const LITE_XRAY_SHADER_PROGRAM: LiteXrayShaderProgram = {
  vertexSource: XRAY_VERTEX_SOURCE,
  fragmentSource: XRAY_FRAGMENT_SOURCE,
  attributes: XRAY_ATTRIBUTES,
  uniforms: XRAY_UNIFORMS,
  samplers: XRAY_SAMPLERS,
};
