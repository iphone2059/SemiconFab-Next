/**
 * Wafer-follow effect owner (native Lite): marker/flange/door, parented amber point light
 * and the bounded additive trail.
 *
 * Parity source: web_app/src/babylon-webgpu.ts:187-218 and 528-547. Owns the three PBR
 * materials, the trail ShaderMaterial and its once-allocated position/normal/colour/index
 * buffers, the point light and the root parenting; it never touches the scene clip plane or
 * the X-Ray palette. Frame-driven by wafer telemetry only, so there is no per-frame update:
 * every mutation arrives through `setPoint` / `setTrail`.
 */
import {
  addToScene, createBox, createMeshFromData, createPbrMaterial, createPointLight,
  createShaderMaterial, setLightIntensity, setMeshDrawRange, setParent, setPbrEmissive,
  setShaderUniform, setSubtreeVisible, updateMeshColors, updateMeshPositions,
  type ClipPlane, type EngineContext, type Mesh, type PointLight, type SceneContext,
  type TransformNode,
} from '@babylonjs/lite';
import { CUT_PLANE_UNIFORM } from '@/rendering/lite-effects-cut';

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
const TRAIL_UNIFORMS = ['world', 'viewProjection', { ...CUT_PLANE_UNIFORM }] as const;

export interface LiteWaferEffectOptions {
  /** Domain-RH composition root the marker hierarchy and trail parent under. */
  readonly root: TransformNode;
}

export interface LiteWaferEffect {
  readonly meshes: readonly Mesh[];
  readonly lights: readonly PointLight[];
  /**
   * Frozen babylon-webgpu.ts:512 signature is (x, y, z, visible, focus, rotationY?).
   * The Lite effects boundary only owns the marker/light; camera focus stays in the
   * integration camera. Callers that do not request focus pass the rotation directly as
   * the fifth argument (tests/lite-effects.test.ts:131).
   */
  setPoint(x: number, y: number, z: number, visible: boolean,
    focusOrRotationY?: boolean | number, rotationY?: number): void;
  setTrail(points: readonly (readonly [number, number, number])[]): void;
  /** Copy the section-cut plane into the trail shader (same half-space discard). */
  setCutPlane(plane: ClipPlane): void;
  dispose(): void;
}

export function createLiteWaferEffect(
  scene: SceneContext, engine: EngineContext, options: LiteWaferEffectOptions,
): LiteWaferEffect {
  const { root } = options;
  const meshes: Mesh[] = [];
  const lights: PointLight[] = [];
  let disposed = false;

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

  // ---- Bounded additive trail (babylon-webgpu.ts:528-547). ----
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

  function setTrail(points: readonly (readonly [number, number, number])[]): void {
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

  function setPoint(x: number, y: number, z: number, visible: boolean,
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

  function setCutPlane(plane: ClipPlane): void {
    if (disposed) return;
    setShaderUniform(trailMaterial, 'cutPlane', plane);
  }

  function dispose(): void {
    // Mesh/material/light lifetime is scene-owned (disposeScene releases them); this owner
    // only stops accepting telemetry so a late callback cannot mutate a disposed scene.
    disposed = true;
  }

  return { meshes, lights, setPoint, setTrail, setCutPlane, dispose };
}
