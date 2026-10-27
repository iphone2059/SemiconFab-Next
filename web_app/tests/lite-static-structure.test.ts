import { beforeEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
vi.hoisted(() => {
  Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 } });
});
const textureGpu = vi.hoisted(() => ({ live: new Set<object>(), upload: vi.fn() }));
vi.mock('@babylonjs/lite', async importOriginal => ({
  ...await importOriginal<typeof import('@babylonjs/lite')>(),
  // GPU texture upload cannot run under Node. Native geometry, transforms,
  // grouping, materials and scene ownership remain real; browser tests cover uploads.
  createDynamicTexture: (_engine: unknown, width: number, height: number) => {
    const texture = { width, height, texture: { destroy() { textureGpu.live.delete(texture); } }, view: {}, sampler: {} };
    textureGpu.live.add(texture); return texture;
  },
  updateDynamicTexture: textureGpu.upload,
}));
import { createSceneContext, disposeScene, getMeshGeometry, getPbrEmissiveColor, getPbrTransmission, hasMaterialUvTransform,
  type EngineContext, type PbrMaterialProps, type StandardMaterialProps } from '@babylonjs/lite';
import reference from './fixtures/lite-static-structure-reference.json';
import { createLiteStaticStructure, type StaticSurfaceDefinition } from '../src/rendering/lite/geometry/static-structure';
const surfaces = reference.materials as Record<string, StaticSurfaceDefinition>;

beforeEach(() => { textureGpu.live.clear(); textureGpu.upload.mockReset(); });
function testScene() {
  const engine = { _renderingContexts: [], _device: {
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size);
      return { getMappedRange: () => data, unmap() {}, destroy() {} };
    },
  } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, {
    get: () => () => {}, set: () => true,
  }) }) });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  return { scene, engine };
}
function fixture() {
  const { scene, engine } = testScene();
  return { scene, model: createLiteStaticStructure(scene, engine) };
}
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('retains every frozen static mesh and its actual world matrix and rendered bounds', () => {
  const { scene, model } = fixture();
  try {
    expect(model.parts).toHaveLength(1648);
    const parts = new Map(model.parts.map(part => [part.name, part]));
    expect(parts.size).toBe(1648);
    for (const row of reference.entities) {
      const part = parts.get(row.name)!;
      expect(part, row.name).toBeDefined();
      expect(part.layer).toBe(row.layer);
      const matrix = part.mesh.thinInstances
        ? part.mesh.thinInstances.matrices.subarray(part.instanceIndex * 16, (part.instanceIndex + 1) * 16)
        : part.mesh.worldMatrix;
      Array.from(matrix).forEach((value, axis) => expect(value, `${row.name}:matrix:${axis}`).toBeCloseTo(row.matrix[axis], 5));
      const positions = getMeshGeometry(part.mesh)!.positions;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[i] + matrix[axis + 4] * positions[i + 1]
          + matrix[axis + 8] * positions[i + 2] + matrix[axis + 12];
        min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
      min.forEach((value, axis) => expect(value, `${row.name}:min:${axis}`).toBeCloseTo(row.min[axis], 5));
      max.forEach((value, axis) => expect(value, `${row.name}:max:${axis}`).toBeCloseTo(row.max[axis], 5));
    }
    expect(model.batches.length).toBeLessThan(model.parts.length / 2);
    expect(scene.meshes).toHaveLength(model.batches.length);
  } finally { model.dispose(); disposeScene(scene); vi.unstubAllGlobals(); }
});

it('preserves frozen triangle vertices, normals, UVs and indices rather than replacing pipes or detailed facilities with boxes', () => {
  const { scene, model } = fixture();
  try {
    for (const row of reference.entities) {
      const part = model.parts.find(part => part.name === row.name)!;
      const material = surfaces[row.materialHash];
      if (material.kind === 'line') continue; // Native line systems are checked in browser and by bounds above.
      const geometry = getMeshGeometry(part.mesh)!;
      expect(hash({ positions: Array.from(geometry.positions), normals: Array.from(geometry.normals),
        uvs: Array.from(geometry.uvs ?? []), indices: Array.from(geometry.indices), lines: false }), row.name).toBe(row.geometryHash);
    }
  } finally { model.dispose(); disposeScene(scene); vi.unstubAllGlobals(); }
});

it('keeps PBR/Standard colors, opacity, specular and emissive inputs and native curtain transmission', () => {
  const { scene, model } = fixture();
  try {
    for (const row of reference.entities) {
      const part = model.parts.find(part => part.name === row.name)!;
      const source = surfaces[row.materialHash];
      if (source.kind === 'line') continue;
      if (source.kind === 'pbr') {
        const material = part.mesh.material as PbrMaterialProps;
        expect(material.baseColorFactor).toEqual([...source.color, source.alpha]);
        expect(material.metallicFactor).toBe(source.metallic);
        expect(material.roughnessFactor).toBe(source.roughness);
        expect(getPbrEmissiveColor(material)).toEqual(source.emissive);
        if (source.texture) expect(hasMaterialUvTransform(material), row.name + ':floor tiling').toBe(true);
        if (source.refraction) expect(getPbrTransmission(material)).toEqual({
          intensity: source.refraction.intensity, indexOfRefraction: source.refraction.ior,
        });
      } else {
        const material = part.mesh.material as StandardMaterialProps;
        expect(material.diffuseColor).toEqual(source.color);
        expect(material.alpha).toBe(source.alpha);
        expect(material.emissiveColor).toEqual(source.emissive);
        expect(material.specularColor).toEqual(source.specular);
        expect(material.specularPower).toBe(source.power);
      }
    }
  } finally { model.dispose(); disposeScene(scene); vi.unstubAllGlobals(); }
});

it('moves and hides B1/FFU independently while keeping basement lights active and applying their B1 offset', () => {
  const { scene, model } = fixture();
  try {
    expect(model.lights).toHaveLength(10);
    for (const light of model.lights) {
      const original = reference.lights.find(row => row.name === light.name)!;
      [light.position.x, light.position.y, light.position.z].forEach((value, axis) =>
        expect(value).toBeCloseTo(original.position[axis], 5));
      expect(light.diffuse).toEqual(original.color);
      expect(light.intensity).toBe(original.intensity);
      expect(light.range).toBe(original.range);
    }
    model.setVisible('b1', false);
    model.setVisible('ffu', false);
    expect(model.parts.filter(part => part.layer === 'b1').every(part => part.mesh.visible === false)).toBe(true);
    expect(model.lights.every(light => light.visible !== false)).toBe(true);
    model.setOffset('b1', -18);
    const floor = model.parts.find(part => part.name === 'subfab-floor')!;
    expect(floor.mesh.worldMatrix[13]).toBe(-18);
    expect(model.lights[0].worldMatrix[13]).toBeCloseTo(reference.lights[0].position[1] - 18);
    expect(model.roots.ffu.position.y).toBe(0);
    model.setVisible('b1', true);
    expect(floor.mesh.visible).toBe(true);
  } finally { model.dispose(); disposeScene(scene); vi.unstubAllGlobals(); }
});

it('publishes each transparent surface position through native mesh.worldMatrix for distance sorting', () => {
  const { scene, model } = fixture();
  try {
    for (const row of reference.entities.filter(row => surfaces[row.materialHash].alpha < 1)) {
      const mesh = model.parts.find(part => part.name === row.name)!.mesh;
      expect(mesh.thinInstances, row.name + ':ordinary transparent draw').toBeFalsy();
      for (let axis = 12; axis <= 14; axis++) {
        expect(mesh.worldMatrix[axis], row.name + ':sort position').toBeCloseTo(row.matrix[axis], 5);
      }
    }
  } finally { model.dispose(); disposeScene(scene); vi.unstubAllGlobals(); }
});

it('releases the caller-owned floor texture if its upload fails before scene registration', () => {
  const { scene, engine } = testScene();
  try {
    textureGpu.upload.mockImplementationOnce(() => { throw new Error('texture upload rejected'); });
    expect(() => createLiteStaticStructure(scene, engine)).toThrow('texture upload rejected');
    disposeScene(scene);
    expect(textureGpu.live.size).toBe(0);
  } finally { disposeScene(scene); vi.unstubAllGlobals(); }
});
