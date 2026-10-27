/**
 * Native Lite effects boundary.
 *
 * Ports three frozen Next subsystems onto @babylonjs/lite public APIs only:
 *  - X-Ray hologram: web_app/src/xray-hologram.ts (one WGSL program, per-state materials)
 *    applied per role exactly as web_app/src/legacy-site.ts:449-524 does.
 *  - Dynamic section cut: web_app/src/babylon-webgpu.ts:560-574 (clamped source position,
 *    one axis normal per call, scene clip plane + every effects shader discards).
 *  - Wafer follow: web_app/src/babylon-webgpu.ts:187-218,512-547 (marker/flange/door,
 *    amber point light, bounded additive trail).
 * The hologram shadows are borrowed from the native CSM receiver texture instead of the
 * frozen custom depth pass (the Lite scene already owns those shadows).
 */
import {
  addToScene, createBox, createMeshFromData, createPbrMaterial, createPointLight,
  createShaderMaterial, createStandardMaterial, createTransformNode, enableShaderMaterialInstanceWorld,
  getCsmReceiverTexture, getShaderTexture, onCsmReceiverUpdate, onSceneDispose,
  setClipPlane, setLightIntensity, setMeshDrawRange, setParent, setPbrEmissive, setShadowCasterMaterial,
  setShaderTexture, setShaderUniform, setSubtreeVisible, updateMeshColors,
  updateMeshPositions,
  type ClipPlane, type EngineContext, type Material, type Mesh, type PointLight,
  type SceneContext, type ShadowGenerator, type ShaderMaterial, type Texture2D,
  type TransformNode,
} from '@babylonjs/lite';
import {
  liteXraySystemMatches, liteXraySurfaceState,
  type LiteXrayFilter, type LiteXraySurfaceRole, type LiteXraySurfaceState,
} from './effects-xray-state';

export type LiteCutAxis = 'X' | 'Y' | 'Z';
export interface LiteXrayTarget {
  readonly mesh: Mesh;
  readonly role: LiteXraySurfaceRole;
}

export interface LiteEffects {
  /** Domain-RH composition root; the composition owner reflects it once at the render boundary. */
  readonly root: TransformNode;
  readonly meshes: readonly Mesh[];
  readonly lights: readonly PointLight[];
  update(deltaMs: number, nowMs: number): void;
  configureXrayTargets(targets: readonly LiteXrayTarget[]): void;
  /** Frozen babylon-webgpu.ts name (legacy-site.ts:635). */
  setXrayFilter(filter: LiteXrayFilter | null): void;
  /** Frozen babylon-webgpu.ts spelling kept for the integration boundary. */
  setXRayFilter(filter: LiteXrayFilter | null): void;
  setCutPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void;
  /**
   * Frozen babylon-webgpu.ts:512 signature is (x, y, z, visible, focus, rotationY?).
   * The Lite effects boundary only owns the marker/light; camera focus stays in the
   * integration camera. Callers that do not request focus pass the rotation directly as
   * the fifth argument (tests/lite-effects.test.ts:131).
   */
  setWaferPoint(x: number, y: number, z: number, visible: boolean,
    focusOrRotationY?: boolean | number, rotationY?: number): void;
  setWaferTrail(points: readonly (readonly [number, number, number])[]): void;
  bindShadows(generator: ShadowGenerator): void;
  /** True once the CSM depth texture is actually bound (after the transition warm-up). */
  readonly shadowLinked: boolean;
  /** Acceptance diagnostics: configured X-Ray target counts per source role. */
  readonly targetCounts: { readonly equipment: number; readonly floor: number; readonly subfab: number; readonly oht: number };
  dispose(): void;
}

// Frozen palette constants, xray-hologram.ts:114-116.
const XRAY_TINT: readonly [number, number, number, number] = [2 / 255, 132 / 255, 199 / 255, 26];
const XRAY_GLOW: readonly [number, number, number, number] = [56 / 255, 189 / 255, 248 / 255, 1];
const XRAY_NORMAL_LINE_COLOR: readonly [number, number, number, number] = [217 / 255, 119 / 255, 6 / 255, 0.75];
// xray-hologram.ts:154 setLineXray(true).
const XRAY_LINE_PARAMS: readonly [number, number, number, number] = [1, 0.75, 0, 1.4];
const XRAY_ZERO_PARAMS: readonly [number, number, number, number] = [0, 0, 0, 0];
// Frozen source response: shadowed surfaces retain a .35 legibility floor, unshadowed surfaces
// retain their original color. Color encoding belongs to the output path, not this light response.
const XRAY_LIT_FLOOR = 0.35;

// Frozen source palette colours, xray-hologram.ts:114-116 and babylon-webgpu.ts:188-218.
const rgb = (hex: number): [number, number, number] =>
  [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
const scaleRgb = (color: [number, number, number], scale: number): [number, number, number] =>
  [color[0] * scale, color[1] * scale, color[2] * scale];

// Frozen wafer-follow constants, babylon-webgpu.ts:187-218,534-546.
const WAFER_MARKER_SIZE = { width: 0.5, height: 0.35, depth: 0.4 };
const WAFER_FLANGE_SIZE = { width: 0.12, height: 0.04, depth: 0.12 };
const WAFER_DOOR_SIZE = { width: 0.44, height: 0.3, depth: 0.012 };
const WAFER_FLANGE_Y = 0.195;
const WAFER_DOOR_Z = 0.201;
const WAFER_LIGHT_DIFFUSE: [number, number, number] = [245 / 255, 158 / 255, 11 / 255];
const WAFER_LIGHT_RANGE = 4;
const WAFER_LIGHT_INTENSITY = 0.9;
const TRAIL_CAPACITY = 30;
const TRAIL_POINT_STRIDE = 3;

// ONE WGSL program shared by triangle meshes and catalog line meshes (catalog line meshes
// are the frozen '-wire' meshes, legacy-site.ts:463). `getFinalWorld(input)` is Lite's
// public instancing-aware world helper (enableShaderMaterialInstanceWorld), so the same
// source also serves thin-instanced equipment/subfab batches.
const XRAY_VERTEX_SOURCE = `struct XrayVertexOutput{
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
const XRAY_FRAGMENT_SOURCE = `struct XrayVertexOutput{
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

const XRAY_UNIFORMS = [
  'world', 'view', 'viewProjection', 'cameraPosition',
  { name: 'xrayParams', type: 'vec4<f32>' },
  { name: 'xrayTint', type: 'vec4<f32>' },
  { name: 'xrayGlow', type: 'vec4<f32>' },
  { name: 'xrayOptions', type: 'vec4<f32>' },
  { name: 'xrayNormalColor', type: 'vec4<f32>' },
  { name: 'xrayTime', type: 'f32' },
  { name: 'cutPlane', type: 'vec4<f32>' },
  { name: 'xrayShadowEnabled', type: 'f32' },
  { name: 'xrayCascade0', type: 'mat4x4<f32>' },
  { name: 'xrayCascade1', type: 'mat4x4<f32>' },
  { name: 'xrayCascade2', type: 'mat4x4<f32>' },
  { name: 'xrayCascade3', type: 'mat4x4<f32>' },
  { name: 'xrayViewFrustumZ', type: 'vec4<f32>' },
  { name: 'xrayFrustumLengths', type: 'vec4<f32>' },
  { name: 'xrayShadowsInfo', type: 'vec4<f32>' },
  { name: 'xrayCsmParams', type: 'vec4<f32>' },
] as const;
// Product composition borrows the live 2-layer CSM receiver; the palette casts through a
// depth-only Standard material so the caster pass never binds a sampler on the writable depth map.
const XRAY_SAMPLERS = [{ name: 'xrayDepth', sampleType: 'depth', viewDimension: '2d-array', comparison: true }] as const;

// Wafer trail: one bounded, additive line-list; all 30 vertices and all 58 indices are
// allocated once (babylon-webgpu.ts:534-546 allocates a bounded, updatable line once).
const TRAIL_VERTEX_SOURCE = `struct TrailVertexOutput{
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) worldPosition: vec3<f32>,
};
@vertex
fn mainVertex(input: VertexInput) -> TrailVertexOutput {
  var output: TrailVertexOutput;
  let worldPosition = shaderSystem.world * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.worldPosition = worldPosition.xyz;
  output.position = shaderSystem.viewProjection * worldPosition;
  return output;
}`;
const TRAIL_FRAGMENT_SOURCE = `struct TrailVertexOutput{
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) worldPosition: vec3<f32>,
};
@fragment
fn mainFragment(input: TrailVertexOutput) -> @location(0) vec4<f32> {
  if (dot(vec4<f32>(input.worldPosition, 1.0), shaderUniforms.cutPlane) > 0.0) { discard; }
  return input.color;
}`;
const TRAIL_UNIFORMS = [
  'world', 'viewProjection',
  { name: 'cutPlane', type: 'vec4<f32>' },
] as const;

interface SavedXrayTarget {
  readonly material: Material;
  readonly xrayCaster: boolean | undefined;
}

export interface LiteEffectsOptions {
  /** Product composition: borrow the live CSM receiver (2-layer depth32float + comparison sampler)
   * so the hologram is modulated by the same shadow map as native PBR. Palette materials cast
   * through a depth-only Standard material, which keeps the CSM caster pass free of the receiver
   * sampler (Lite 1.36 otherwise reports a writable+sampled usage conflict inside refit frames).
   * Standalone unit fixtures omit it and never render the palette. */
  readonly shadows?: ShadowGenerator;
}

export function createLiteEffects(scene: SceneContext, engine: EngineContext, options: LiteEffectsOptions = {}): LiteEffects {
  const root = createTransformNode('native-effects');
  const meshes: Mesh[] = [];
  const lights: PointLight[] = [];

  // ---- Wafer-follow marker/flange/door + amber point light (babylon-webgpu.ts:187-218). ----
  const markerMaterial = createPbrMaterial({
    baseColorFactor: [...rgb(0xf59e0b), 1], metallicFactor: 0.35, roughnessFactor: 0.3,
    directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false,
  });
  markerMaterial.name = 'wafer-follow-marker-material';
  setPbrEmissive(markerMaterial, scaleRgb(rgb(0xd97706), 0.65));
  const flangeMaterial = createPbrMaterial({
    baseColorFactor: [...rgb(0x334155), 1], metallicFactor: 0, roughnessFactor: 0.6,
    directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false,
  });
  flangeMaterial.name = 'wafer-follow-flange';
  const doorMaterial = createPbrMaterial({
    baseColorFactor: [...rgb(0x1e293b), 1], metallicFactor: 0.5, roughnessFactor: 0.2,
    directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false,
  });
  doorMaterial.name = 'wafer-follow-door';

  const marker = createBox(engine, WAFER_MARKER_SIZE);
  marker.name = 'wafer-follow-marker';
  marker.material = markerMaterial;
  marker.pickable = false;
  addToScene(scene, marker);
  meshes.push(marker);
  setParent(marker, root);

  const flange = createBox(engine, WAFER_FLANGE_SIZE);
  flange.name = 'wafer-follow-flange-mesh';
  flange.material = flangeMaterial;
  flange.pickable = false;
  flange.position.y = WAFER_FLANGE_Y;
  addToScene(scene, flange);
  meshes.push(flange);
  setParent(flange, marker);
  flange.position.y = WAFER_FLANGE_Y;

  const door = createBox(engine, WAFER_DOOR_SIZE);
  door.name = 'wafer-follow-door-mesh';
  door.material = doorMaterial;
  door.pickable = false;
  addToScene(scene, door);
  meshes.push(door);
  setParent(door, marker);
  door.position.z = WAFER_DOOR_Z;

  const waferLight = createPointLight([0, 0.3, 0], 0);
  waferLight.name = 'wafer-follow-light';
  waferLight.diffuse = [WAFER_LIGHT_DIFFUSE[0], WAFER_LIGHT_DIFFUSE[1], WAFER_LIGHT_DIFFUSE[2]];
  waferLight.specular = [WAFER_LIGHT_DIFFUSE[0], WAFER_LIGHT_DIFFUSE[1], WAFER_LIGHT_DIFFUSE[2]];
  waferLight.range = WAFER_LIGHT_RANGE;
  addToScene(scene, waferLight);
  lights.push(waferLight);
  setParent(waferLight, marker);
  waferLight.position.set(0, 0.3, 0);
  // babylon-webgpu.ts:201 setEnabled(false): the whole marker hierarchy starts hidden.
  setSubtreeVisible(marker, false);

  // ---- Section cut state (babylon-webgpu.ts:560-574). ----
  let cutPlaneState: ClipPlane = [0, 0, 0, 0];

  // ---- X-Ray palette (xray-hologram.ts:119-201). ----
  const paletteMaterials: ShaderMaterial[] = [];
  const meshMaterials = new Map<string, ShaderMaterial>();
  let xrayClock = 0;
  // Declared before bindShadows(): the CSM receiver callback may run synchronously during
  // bindShadows and uses this to decide whether the palette fan-out is observable.
  let activeFilter: LiteXrayFilter | null = null;

  // ---- Shadow borrowing: the generator keeps ownership, the palette only binds. ----
  let shadowGenerator: ShadowGenerator | undefined;
  let shadowTexture: Texture2D | null = null;
  let shadowData: Float32Array | null = null;
  // B04: the receiver UBO is 80 floats. Reuse one buffer and its eight subarray views
  // instead of allocating a fresh typed array per callback and eight views per material.
  let shadowViews: {
    cascade0: Float32Array; cascade1: Float32Array; cascade2: Float32Array; cascade3: Float32Array;
    viewFrustumZ: Float32Array; frustumLengths: Float32Array; shadowsInfo: Float32Array; csmParams: Float32Array;
  } | null = null;
  let detachCsmReceiver: (() => void) | undefined;

  function applyShadowBinding(material: ShaderMaterial): void {
    if (shadowTexture && getShaderTexture(material, 'xrayDepth') !== shadowTexture) {
      setShaderTexture(material, 'xrayDepth', shadowTexture);
    }
    setShaderUniform(material, 'xrayShadowEnabled', shadowTexture && shadowData ? 1 : 0);
    if (shadowData) writeCsmUniforms(material);
  }

  function receiveShadowData(data: Float32Array): void {
    if (!shadowData || !shadowViews || shadowData.length !== data.length) {
      shadowData = new Float32Array(data.length);
      shadowViews = {
        cascade0: shadowData.subarray(0, 16),
        cascade1: shadowData.subarray(16, 32),
        cascade2: shadowData.subarray(32, 48),
        cascade3: shadowData.subarray(48, 64),
        viewFrustumZ: shadowData.subarray(64, 68),
        frustumLengths: shadowData.subarray(68, 72),
        shadowsInfo: shadowData.subarray(72, 76),
        csmParams: shadowData.subarray(76, 80),
      };
    }
    shadowData.set(data);
  }

  function writeCsmUniforms(material: ShaderMaterial): void {
    if (!shadowViews) return;
    setShaderUniform(material, 'xrayCascade0', shadowViews.cascade0);
    setShaderUniform(material, 'xrayCascade1', shadowViews.cascade1);
    setShaderUniform(material, 'xrayCascade2', shadowViews.cascade2);
    setShaderUniform(material, 'xrayCascade3', shadowViews.cascade3);
    setShaderUniform(material, 'xrayViewFrustumZ', shadowViews.viewFrustumZ);
    setShaderUniform(material, 'xrayFrustumLengths', shadowViews.frustumLengths);
    setShaderUniform(material, 'xrayShadowsInfo', shadowViews.shadowsInfo);
    setShaderUniform(material, 'xrayCsmParams', shadowViews.csmParams);
  }

  function syncMaterialFrame(material: ShaderMaterial): void {
    setShaderUniform(material, 'cutPlane', cutPlaneState);
    setShaderUniform(material, 'xrayTime', xrayClock);
    applyShadowBinding(material);
  }

  function createHologramMaterial(name: string, line: boolean, state?: LiteXraySurfaceState): ShaderMaterial {
    const material = createShaderMaterial({
      name,
      vertexSource: XRAY_VERTEX_SOURCE,
      fragmentSource: XRAY_FRAGMENT_SOURCE,
      attributes: ['position'],
      uniforms: [...XRAY_UNIFORMS],
      samplers: [...XRAY_SAMPLERS],
      needAlphaBlending: true,
      blendMode: 'alpha',
      backFaceCulling: false,
      // xray-hologram.ts:147: highlighted utility surfaces write depth, ghosts do not.
      depthWrite: line ? false : (state?.highlight ?? 0) >= 0.5,
      ...(line ? { topology: 'line-list' as const } : {}),
    });
    enableShaderMaterialInstanceWorld(material);
    paletteMaterials.push(material);
    // CSM casters use a depth-only Standard view so the shadow pass never binds the palette's
    // receiver sampler while writing the same depth texture (Lite 1.36 usage-scope conflict).
    if (casterMaterial) setShadowCasterMaterial(material, casterMaterial);
    setShaderUniform(material, 'xrayTint', XRAY_TINT);
    setShaderUniform(material, 'xrayGlow', XRAY_GLOW);
    if (line) {
      setShaderUniform(material, 'xrayOptions', [1, 0, 0, 0]);
      setShaderUniform(material, 'xrayNormalColor', XRAY_NORMAL_LINE_COLOR);
      setShaderUniform(material, 'xrayParams', XRAY_ZERO_PARAMS);
    } else {
      setShaderUniform(material, 'xrayOptions', [0, 0, 0, 0]);
      setShaderUniform(material, 'xrayNormalColor', [0, 0, 0, 0]);
      setShaderUniform(material, 'xrayParams', [1, state!.ghostAlpha, state!.highlight, state!.rimPower]);
    }
    syncMaterialFrame(material);
    return material;
  }

  const casterMaterial: Material | null = options.shadows
    ? (() => {
      const material = createStandardMaterial();
      material.name = 'fab-xray-shadow-caster';
      material.diffuseColor = [0.5, 0.5, 0.5];
      material.alpha = 1;
      return material;
    })()
    : null;
  const lineMaterial = createHologramMaterial('fab-xray-line', true);
  // Product composition: bind the live CSM receiver before the first rendered frame.
  if (options.shadows) bindShadows(options.shadows);
  function meshMaterial(state: LiteXraySurfaceState): ShaderMaterial {
    // xray-hologram.ts:136-151: one material instance per ghost/highlight state.
    const key = state.highlight + ':' + state.ghostAlpha + ':' + state.rimPower;
    let material = meshMaterials.get(key);
    if (!material) {
      material = createHologramMaterial('fab-xray-' + meshMaterials.size, false, state);
      meshMaterials.set(key, material);
    }
    return material;
  }

  function setLineXray(enabled: boolean): void {
    setShaderUniform(lineMaterial, 'xrayParams', enabled ? XRAY_LINE_PARAMS : XRAY_ZERO_PARAMS);
  }

  function syncShadowTexture(): void {
    if (!shadowGenerator) return;
    const next = getCsmReceiverTexture(shadowGenerator);
    if (next === shadowTexture) return;
    shadowTexture = next;
    for (const material of paletteMaterials) applyShadowBinding(material);
  }

  function bindShadows(generator: ShadowGenerator): void {
    detachCsmReceiver?.();
    shadowGenerator = generator;
    shadowData = null;
    shadowTexture = getCsmReceiverTexture(generator);
    // The generator publishes its 80-float receiver UBO (four cascade matrices + slices)
    // right before the shadow map renders; custom ShaderMaterial receivers MUST mirror it
    // from inside this callback rather than an onBeforeRender hook.
    detachCsmReceiver = onCsmReceiverUpdate(generator, data => {
      if (disposed) return;
      receiveShadowData(data);
      // B04: while X-Ray is active the palette materials are attached to rendered meshes and
      // must mirror the receiver UBO. While it is inactive no mesh uses them, so the
      // per-material uniform fan-out is skipped; enabling resyncs from the retained snapshot.
      if (activeFilter === null) return;
      for (const material of paletteMaterials) {
        setShaderUniform(material, 'xrayShadowEnabled', shadowTexture ? 1 : 0);
        writeCsmUniforms(material);
      }
    });
    for (const material of paletteMaterials) applyShadowBinding(material);
  }

  // ---- X-Ray target application/restoration (legacy-site.ts:469-524). ----
  const savedTargets = new Map<Mesh, SavedXrayTarget>();
  let xrayTargets: readonly LiteXrayTarget[] = [];

  function readXrayCaster(mesh: Mesh): boolean | undefined {
    const metadata = mesh.metadata as { xrayCaster?: boolean } | null | undefined;
    return metadata?.xrayCaster;
  }

  function restoreXray(): void {
    for (const [mesh, saved] of savedTargets) {
      mesh.material = saved.material;
      const metadata = (mesh.metadata ?? {}) as Record<string, unknown>;
      if (saved.xrayCaster === undefined) delete metadata.xrayCaster;
      else metadata.xrayCaster = saved.xrayCaster;
      mesh.metadata = metadata;
    }
    savedTargets.clear();
    setLineXray(false);
  }

  function applyXray(filter: LiteXrayFilter | null): void {
    restoreXray();
    activeFilter = filter;
    if (!filter) return;
    for (const target of xrayTargets) {
      const mesh = target.mesh;
      if (!mesh || savedTargets.has(mesh)) continue;
      // legacy-site.ts:468 excludes the AMHS contact-shadow decals from the X-Ray surface set.
      if (target.role === 'oht' && mesh.name.includes('-shadow')) continue;
      savedTargets.set(mesh, { material: mesh.material, xrayCaster: readXrayCaster(mesh) });
      // Catalog wire meshes keep the frozen '-wire' identity and use the same program with
      // line-list topology (xray-hologram.ts:198, legacy-site.ts:463-464).
      const line = mesh.name.endsWith('-wire');
      const activeRole = target.role !== 'subfab'
        || filter === 'all' || liteXraySystemMatches(mesh.name, filter);
      mesh.material = line ? lineMaterial : meshMaterial(liteXraySurfaceState(target.role, filter, activeRole));
      mesh.metadata = { ...mesh.metadata, xrayCaster: true };
    }
    // B04: the CSM fan-out pauses while X-Ray is off; re-apply the retained receiver
    // snapshot before the first active frame so the visuals are unchanged.
    for (const material of paletteMaterials) applyShadowBinding(material);
    setLineXray(true);
    updateXrayFrame();
  }

  function updateXrayFrame(): void {
    for (const material of paletteMaterials) setShaderUniform(material, 'xrayTime', xrayClock);
    syncShadowTexture();
  }

  // ---- Wafer trail (babylon-webgpu.ts:528-547). ----
  const trailPositions = new Float32Array(TRAIL_CAPACITY * TRAIL_POINT_STRIDE);
  const trailNormals = new Float32Array(TRAIL_CAPACITY * TRAIL_POINT_STRIDE);
  const trailColors = new Float32Array(TRAIL_CAPACITY * 4);
  const trailIndices = new Uint32Array((TRAIL_CAPACITY - 1) * 2);
  for (let index = 0; index < TRAIL_CAPACITY - 1; index += 1) {
    trailIndices[index * 2] = index;
    trailIndices[index * 2 + 1] = index + 1;
  }
  const trailMaterial = createShaderMaterial({
    name: 'wafer-follow-trail-material',
    vertexSource: TRAIL_VERTEX_SOURCE,
    fragmentSource: TRAIL_FRAGMENT_SOURCE,
    attributes: ['position', 'color'],
    uniforms: [...TRAIL_UNIFORMS],
    needAlphaBlending: true,
    blendMode: 'additive',
    backFaceCulling: false,
    depthWrite: false,
    topology: 'line-list',
  });
  const trail = createMeshFromData(engine, 'wafer-follow-trail', trailPositions, trailNormals,
    trailIndices, undefined, undefined, undefined, trailColors);
  trail.material = trailMaterial;
  trail.pickable = false;
  trail.visible = false;
  trail.metadata = { staticShadowCaster: false };
  addToScene(scene, trail);
  meshes.push(trail);
  setParent(trail, root);
  const lastTrailPositions = new Float32Array(trailPositions.length);
  let lastTrailCount = -1;
  let lastTrailLength = -1;
  let lastTrailColorLength = -1;
  let disposed = false;
  let detachSceneDispose: () => void = () => {};

  function uploadTrail(points: readonly (readonly [number, number, number])[], count: number): void {
    for (let index = 0; index < TRAIL_CAPACITY; index += 1) {
      // Frozen source: Array.from({length: 30}, (_, i) => points[Math.min(i, count - 1)]).
      const source = points[Math.min(index, count - 1)];
      const offset = index * TRAIL_POINT_STRIDE;
      trailPositions[offset] = source[0];
      trailPositions[offset + 1] = source[1];
      trailPositions[offset + 2] = source[2];
    }
    let changed = count !== lastTrailCount || points.length !== lastTrailLength;
    if (!changed) {
      for (let index = 0; index < trailPositions.length; index += 1) {
        if (lastTrailPositions[index] !== trailPositions[index]) { changed = true; break; }
      }
    }
    if (!changed) return;
    lastTrailPositions.set(trailPositions);
    lastTrailCount = count;
    lastTrailLength = points.length;
    updateMeshPositions(engine, trail, trailPositions);
    if (lastTrailColorLength !== points.length) {
      // Frozen colours: f = (index + 1) / points.length over the full source trace.
      for (let index = 0; index < TRAIL_CAPACITY; index += 1) {
        const fade = (index + 1) / points.length;
        const offset = index * 4;
        trailColors[offset] = 0.96 * fade;
        trailColors[offset + 1] = (0.6 + 0.3 * fade) * fade;
        trailColors[offset + 2] = 0.05 * fade;
        trailColors[offset + 3] = 0.9;
      }
      updateMeshColors(engine, trail, trailColors);
      lastTrailColorLength = points.length;
    }
    // Bounded draw: (count - 1) segments = two indices each, out of the retained capacity.
    setMeshDrawRange(engine, trail, {
      vertices: { offset: 0, count: TRAIL_CAPACITY },
      indices: { offset: 0, count: (count - 1) * 2 },
    });
  }

  function setWaferTrail(points: readonly (readonly [number, number, number])[]): void {
    if (disposed) return;
    const count = Math.min(TRAIL_CAPACITY, points.length);
    if (count < 2) {
      trail.visible = false;
      lastTrailCount = -1;
      lastTrailLength = -1;
      return;
    }
    uploadTrail(points, count);
    trail.visible = true;
  }

  function setWaferPoint(x: number, y: number, z: number, visible: boolean,
    focusOrRotationY?: boolean | number, rotationY?: number): void {
    if (disposed) return;
    // Frozen source passes camera focus as the 5th argument; the Lite camera owner keeps
    // that behavior, so only the marker rotation is consumed here.
    const rotation = typeof focusOrRotationY === 'number' ? focusOrRotationY : rotationY;
    // babylon-webgpu.ts:514-518: delta measured before the move; rotation update only while visible.
    const dx = x - marker.position.x;
    const dz = z - marker.position.z;
    if (rotation !== undefined) marker.rotation.y = rotation;
    else if (visible && dx * dx + dz * dz > 0.00001) marker.rotation.y = Math.atan2(dx, dz);
    marker.position.set(x, y, z);
    // Parent-chain disable in the frozen renderer; materialized here so every marker part follows.
    setSubtreeVisible(marker, visible);
    setLightIntensity(waferLight, visible ? WAFER_LIGHT_INTENSITY : 0);
  }

  function setCutPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void {
    if (disposed) return;
    if (!active) {
      scene.clipPlane = null;
      cutPlaneState = [0, 0, 0, 0];
    } else {
      const flipped = invert ? -1 : 1;
      const clamped = Math.max(-60, Math.min(60, position));
      // Source plane (babylon-webgpu.ts:567-573) is authored in Next's RH domain; the native
      // render boundary reflects Z exactly once, so only the Z normal component flips.
      const plane: ClipPlane = axis === 'X'
        ? [flipped, 0, 0, -flipped * clamped]
        : axis === 'Y'
          ? [0, flipped, 0, -flipped * clamped]
          : [0, 0, -flipped, -flipped * clamped];
      setClipPlane(scene, plane);
      cutPlaneState = [plane[0], plane[1], plane[2], plane[3]];
    }
    setShaderUniform(trailMaterial, 'cutPlane', cutPlaneState);
    for (const material of paletteMaterials) setShaderUniform(material, 'cutPlane', cutPlaneState);
  }

  function configureXrayTargets(targets: readonly LiteXrayTarget[]): void {
    if (disposed) return;
    restoreXray();
    xrayTargets = targets.slice();
    if (activeFilter !== null) applyXray(activeFilter);
  }

  function setXrayFilter(filter: LiteXrayFilter | null): void {
    if (disposed) return;
    applyXray(filter);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    restoreXray();
    detachCsmReceiver?.();
    detachCsmReceiver = undefined;
    shadowGenerator = undefined;
    shadowTexture = null;
    shadowData = null;
    shadowViews = null;
    savedTargets.clear();
    meshMaterials.clear();
    paletteMaterials.length = 0;
    detachSceneDispose();
    detachSceneDispose = () => {};
  }

  detachSceneDispose = onSceneDispose(scene, dispose);

  return {
    root, meshes, lights,
    update(_deltaMs: number, nowMs: number) {
      if (disposed) return;
      if (Number.isFinite(nowMs)) xrayClock = nowMs / 1000;
      if (activeFilter !== null) {
        for (const material of paletteMaterials) setShaderUniform(material, 'xrayTime', xrayClock);
      }
      syncShadowTexture();
    },
    configureXrayTargets,
    setXrayFilter,
    setXRayFilter: setXrayFilter,
    setCutPlane,
    setWaferPoint,
    setWaferTrail,
    bindShadows,
    get shadowLinked() { return !!shadowTexture && !!shadowData; },
    get targetCounts() {
      const counts = { equipment: 0, floor: 0, subfab: 0, oht: 0 };
      for (const target of xrayTargets) counts[target.role] += 1;
      return counts;
    },
    dispose,
  };
}
