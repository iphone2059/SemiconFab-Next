import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Constants } from '@babylonjs/core/Engines/constants';
import { BufferUsage, TextureUsage } from '@babylonjs/core/Engines/WebGPU/webgpuConstants';
import type { WebGPUHardwareTexture } from '@babylonjs/core/Engines/WebGPU/webgpuHardwareTexture';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { NativeShadowMaterial, type NativeShadowBinding } from './native-shadow-material';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Geometry } from '@babylonjs/core/Meshes/geometry';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Plane } from '@babylonjs/core/Maths/math.plane';

const SIZE = 2048;

function isCaster(mesh: AbstractMesh): boolean {
  const material = mesh.material;
  return mesh.getClassName() !== 'LinesMesh' &&
    mesh.isEnabled() && mesh.isVisible && mesh.visibility === 1 &&
    (material?.alpha ?? 1) === 1 &&
    !material?.needAlphaBlending() && !material?.needAlphaTesting();
}

/** Actual transformed triangles, including parent transforms and Babylon instances. */
export function collectShadowGeometry(meshes: readonly AbstractMesh[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  let meshCount = 0;
  for (const mesh of meshes) {
    if (!isCaster(mesh)) continue;
    const source = mesh.getVerticesData('position');
    const triangles = mesh.getIndices();
    if (!source || !triangles?.length) continue;
    const world = mesh.computeWorldMatrix(true);
    const offset = positions.length / 3;
    for (let i = 0; i < source.length; i += 3) {
      const point = Vector3.TransformCoordinates(Vector3.FromArray(source, i), world);
      positions.push(point.x, point.y, point.z);
    }
    for (const index of triangles) indices.push(index + offset);
    meshCount++;
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), meshCount };
}

/** Camera and material colors deliberately do not participate in cache invalidation. */
export function shadowGeometryKey(meshes: readonly AbstractMesh[]): string {
  const nodes = new Set<TransformNode>();
  const geometry = meshes.map(mesh => {
    if (!isCaster(mesh)) return `${mesh.uniqueId}:off`;
    for (let node: TransformNode | null = mesh; node; node = node.parent as TransformNode | null) nodes.add(node);
    // Revision is bumped by callers that mutate vertex/index data in place.
    // Transform changes are detected independently from the node hierarchy.
    const revision = typeof mesh.metadata?.staticShadowRevision === 'number'
      ? mesh.metadata.staticShadowRevision
      : 0;
    return `${mesh.uniqueId}:${mesh.geometry?.uniqueId ?? '-'}:${mesh.getTotalVertices()}:${mesh.getIndices()?.length ?? 0}:${revision}`;
  });
  for (const node of nodes) {
    geometry.push(`${node.uniqueId}:${node.position.asArray()}:${node.rotation.asArray()}:${node.rotationQuaternion?.asArray()}:${node.scaling.asArray()}`);
  }
  return geometry.join('|');
}

export function createShadowMatrix(direction: Vector3): Matrix {
  const view = Matrix.LookAtRH(direction.normalizeToNew().scale(-150), Vector3.Zero(), Vector3.Up());
  // Babylon matrix multiplication is row-ordered. WebGPU depth is [0,1], not OpenGL [-1,1].
  return view.multiply(Matrix.OrthoOffCenterRH(-78, 78, -72, 72, 1, 300, true));
}

export function shadowClipParameters(plane: Plane | null): number[] {
  return plane ? [plane.normal.x, plane.normal.y, plane.normal.z, plane.d] : [0, 0, 0, 0];
}

const depthShader = `
struct Light { vp: mat4x4f, clipPlane: vec4f }
struct Vertex { @builtin(position) position: vec4f, @location(0) world: vec3f }
@group(0) @binding(0) var<uniform> light: Light;
@vertex fn main(@location(0) position: vec3f) -> Vertex {
  var vertex: Vertex;
  vertex.position = light.vp * vec4f(position, 1.0);
  vertex.world = position;
  return vertex;
}
@fragment fn clippedDepth(vertex: Vertex) {
  if (dot(vec4f(vertex.world, 1.0), light.clipPlane) > 0.0) { discard; }
}`;

/** Native depth pass; Babylon only binds its texture for the main-pass WGSL receiver. */
export function createNativeStaticShadows(scene: Scene, engine: WebGPUEngine, light: DirectionalLight, getCasters: () => readonly AbstractMesh[]) {
  // Priority fixes the key at light slot zero for every receiving material.
  light.renderPriority = 100;
  // Babylon sorts scene.lights but retains each already-built mesh's original list.
  for (const mesh of scene.meshes) mesh._resyncLightSources();
  const binding: NativeShadowBinding = { matrix: Matrix.Identity(), enabled: true };
  for (const material of scene.materials) {
    if ((material instanceof StandardMaterial && !material.disableLighting || material instanceof PBRMaterial && !material.unlit) && material.alpha === 1) {
      new NativeShadowMaterial(material, binding);
    }
  }

  let device: GPUDevice;
  let depth: GPUTexture;
  let texture: BaseTexture | undefined;
  let pipeline: GPURenderPipeline;
  let uniform: GPUBuffer;
  let bindGroup: GPUBindGroup;
  let vertex: GPUBuffer | undefined;
  let index: GPUBuffer | undefined;
  let vertexCapacity = 0;
  let indexCapacity = 0;
  let key = '';
  let dirty = true;
  let disposed = false;
  let passes = 0;
  let casterCount = 0;
  let triangleCount = 0;
  let lastReason = 'initialization';
  let lightKey = '';
  let clipKey = '';
  const hookedGeometries = new Set<Geometry>();
  const hookGeometry = (mesh: AbstractMesh): void => {
    const geometry = mesh.geometry;
    if (!geometry || hookedGeometries.has(geometry)) return;
    hookedGeometries.add(geometry);
    const previous = geometry.onGeometryUpdated;
    geometry.onGeometryUpdated = (updated, kind) => {
      if (!disposed) {
        for (const owner of updated.meshes) {
          const metadata = owner.metadata && typeof owner.metadata === 'object' ? owner.metadata : {};
          const revision = typeof metadata.staticShadowRevision === 'number' ? metadata.staticShadowRevision : 0;
          owner.metadata = { ...metadata, staticShadowRevision: revision + 1 };
        }
        dirty = true;
        lastReason = 'geometry-updated';
      }
      previous?.(updated, kind);
    };
  };
  const release = () => {
    vertex?.destroy(); index?.destroy(); uniform?.destroy();
    vertex = undefined; index = undefined;
    vertexCapacity = 0; indexCapacity = 0;
    // The Babylon wrapper owns the native texture and destroys it on disposal.
    texture?.dispose(); texture = undefined;
    binding.texture = undefined;
  };
  const initialize = () => {
    device = engine._device;
    depth = device.createTexture({ label: 'FAB static depth', size: [SIZE, SIZE], format: 'depth32float',
      usage: TextureUsage.RenderAttachment | TextureUsage.TextureBinding | TextureUsage.CopySrc });
    const internal = engine.wrapWebGPUTexture(depth);
    internal.comparisonFunction = Constants.LEQUAL;
    internal.samplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
    internal.generateMipMaps = false;
    (internal._hardwareTexture as WebGPUHardwareTexture).createView();
    texture = new BaseTexture(scene, internal);
    texture.name = 'FAB native shadow depth';
    texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    binding.texture = texture;
    uniform = device.createBuffer({ label: 'FAB light VP and world clip plane', size: 80, usage: BufferUsage.Uniform | BufferUsage.CopyDst });
    const module = device.createShaderModule({ code: depthShader });
    pipeline = device.createRenderPipeline({ label: 'FAB static depth-only', layout: 'auto',
      vertex: { module, entryPoint: 'main',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module, entryPoint: 'clippedDepth', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 1, depthBiasSlopeScale: 1 } });
    bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    dirty = true;
  };
  initialize();
  const update = () => {
    if (disposed) return;
    if (device !== engine._device) { release(); initialize(); lastReason = 'device-restored'; }
    const casters = getCasters();
    for (const mesh of casters) hookGeometry(mesh);
    const nextKey = shadowGeometryKey(casters);
    const nextLightKey = light.direction.asArray().join(',');
    const clipPlane = shadowClipParameters(scene.clipPlane);
    const nextClipKey = clipPlane.join(',');
    if (!dirty && key === nextKey && lightKey === nextLightKey && clipKey === nextClipKey) return;
    if (!dirty) lastReason = key !== nextKey ? 'geometry-or-visibility' : clipKey !== nextClipKey ? 'clip-plane' : 'light-direction';
    const geometry = collectShadowGeometry(casters);
    const lightVP = createShadowMatrix(light.direction);
    binding.matrix = lightVP;
    device.queue.writeBuffer(uniform, 0, new Float32Array([...lightVP.asArray(), ...clipPlane]));
    // Grow geometrical buffers geometrically and reuse them across cache rebuilds.
    const vertexNeeded = Math.max(4, geometry.positions.byteLength);
    const indexNeeded = Math.max(4, geometry.indices.byteLength);
    if (!vertex || vertexNeeded > vertexCapacity) {
      vertex?.destroy();
      vertexCapacity = Math.max(vertexNeeded, vertexCapacity * 2);
      vertex = device.createBuffer({ size: vertexCapacity, usage: BufferUsage.Vertex | BufferUsage.CopyDst });
    }
    if (!index || indexNeeded > indexCapacity) {
      index?.destroy();
      indexCapacity = Math.max(indexNeeded, indexCapacity * 2);
      index = device.createBuffer({ size: indexCapacity, usage: BufferUsage.Index | BufferUsage.CopyDst });
    }
    if (geometry.indices.length) {
      device.queue.writeBuffer(vertex, 0, geometry.positions);
      device.queue.writeBuffer(index, 0, geometry.indices);
    }
    const encoder = device.createCommandEncoder({ label: 'FAB static shadow encoder' });
    const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    if (geometry.indices.length) {
      pass.setVertexBuffer(0, vertex); pass.setIndexBuffer(index, 'uint32'); pass.drawIndexed(geometry.indices.length);
    }
    pass.end(); device.queue.submit([encoder.finish()]);
    casterCount = geometry.meshCount; triangleCount = geometry.indices.length / 3; passes++;
    key = shadowGeometryKey(casters); lightKey = nextLightKey; clipKey = nextClipKey; dirty = false;
  };
  const before = scene.onBeforeRenderObservable.add(update);
  const controller = {
    get readyForCurrentDevice() { return !disposed && device === engine._device && !dirty; },
    get enabled() { return binding.enabled; },
    set enabled(value: boolean) { binding.enabled = value; },
    get stats() { return { passes, casterCount, triangleCount, lastReason, size: SIZE, format: 'depth32float', clipPlane: shadowClipParameters(scene.clipPlane) }; },
    invalidate(reason: string) { dirty = true; lastReason = reason; },
    dispose() {
      if (disposed) return;
      disposed = true; scene.onBeforeRenderObservable.remove(before); release();
      binding.texture = undefined;
    },
  };
  scene.onDisposeObservable.addOnce(() => controller.dispose());
  return controller;
}
