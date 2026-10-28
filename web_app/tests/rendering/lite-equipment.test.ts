import { expect, it, vi } from 'vitest';
vi.hoisted(() => {
  Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 } });
});
import {
  createSceneContext, disposeScene, getMeshGeometry,
  type EngineContext, type Mesh, type PbrMaterialProps,
} from '@babylonjs/lite';
import reference from '../fixtures/original-tool-reference.json';
import identities from '../fixtures/twin-layout-identities.json';
import { createLiteEquipment } from '../../src/rendering/lite/geometry/tool-families';

// Only WebGPU buffer allocation is doubled. Geometry, transforms, materials,
// thin-instance arrays, scene membership and disposal execute the real Lite API.
function equipment() {
  const engine = { _renderingContexts: [], _device: {
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size);
      return { getMappedRange: () => data, unmap() {}, destroy() {} };
    },
  } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const model = createLiteEquipment(scene, engine);
  return { scene, model };
}
const key = (values: readonly number[]) => values.map(value => Math.round(value * 10000)).join(',');
function points(mesh: Mesh, instanceIndex: number) {
  const positions = getMeshGeometry(mesh)!.positions;
  const matrix = mesh.thinInstances!.matrices;
  const offset = instanceIndex * 16;
  const result: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = positions.subarray(i, i + 3);
    result.push([0, 1, 2].map(axis => matrix[offset + axis] * x + matrix[offset + 4 + axis] * y
      + matrix[offset + 8 + axis] * z + matrix[offset + 12 + axis]));
  }
  return result;
}

it('keeps all 121 placement identities distinct through batch/instance lookup, including repeated records', () => {
  const { scene, model } = equipment();
  try {
    expect(model.tools).toHaveLength(121);
    expect(new Set(model.tools.map(tool => tool.instanceId)).size).toBe(121);
    for (const identity of identities) {
      const tool = model.tools[identity.layout_index];
      expect(tool.instanceId).toBe(identity.instance_id);
      expect(tool.recordId).toBe(identity.record_id);
      for (const part of tool.parts) {
        expect(model.resolve(model.batches[part.batchIndex].mesh, part.instanceIndex)).toBe(tool);
      }
    }
    expect(model.resolve(model.batches[0].mesh, -1)).toBeUndefined();
    expect(model.resolve(model.batches[0].mesh, 0.5)).toBeUndefined();
    expect(model.resolve(model.batches[0].mesh, 9999)).toBeUndefined();
    expect(model.resolve({} as Mesh, 0)).toBeUndefined();
    expect(model.batches.length).toBeLessThan(121);
    expect(scene.meshes).toHaveLength(model.batches.length);
  } finally { disposeScene(scene); }
});

it('matches the rendered world bounds of every frozen tool using the actual thin-instance matrices', () => {
  const { scene, model } = equipment();
  try {
    for (const original of reference.tools) {
      const tool = model.tools[original.layoutIndex];
      const vertices = tool.parts.filter(part => part.role !== 'wire'
        && (original.family === 'catalog' || part.role === 'body'))
        .flatMap(part => points(model.batches[part.batchIndex].mesh, part.instanceIndex));
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.min(...vertices.map(point => point[axis])), `${tool.instanceId}:min:${axis}`).toBeCloseTo(original.min[axis], 5);
        expect(Math.max(...vertices.map(point => point[axis])), `${tool.instanceId}:max:${axis}`).toBeCloseTo(original.max[axis], 5);
      }
    }
  } finally { disposeScene(scene); }
});

it('reproduces the eight frozen family vertex clouds and linear per-part colors', () => {
  const { scene, model } = equipment();
  try {
    for (const family of reference.families) {
      const sample = reference.tools.find(tool => tool.family === family.family)!;
      const tool = model.tools[sample.layoutIndex];
      const actual = new Set<string>();
      for (const part of tool.parts.filter(part => part.role === 'body')) {
        const mesh = model.batches[part.batchIndex].mesh;
        const color = (mesh.material as PbrMaterialProps).baseColorFactor!.slice(0, 3);
        // Fixture coordinates are in the tool frame. Invert its frozen yaw/translation.
        const cos = Math.cos(sample.rotation), sin = Math.sin(sample.rotation);
        for (const point of points(mesh, part.instanceIndex)) {
          const x = point[0] - sample.position[0], z = point[2] - sample.position[2];
          actual.add(key([cos * x - sin * z, point[1] - sample.position[1], sin * x + cos * z, ...color]));
        }
      }
      const expected = new Set(family.points.map((point, i) => key([...point, ...family.colors.slice(i * 3, i * 3 + 3)])));
      expect([...actual].sort(), family.family).toEqual([...expected].sort());
    }
  } finally { disposeScene(scene); }
});

it('preserves catalog geometry, material factors and all original wire edges', () => {
  const { scene, model } = equipment();
  try {
    for (const original of reference.catalog) {
      const tool = model.tools.find(tool => tool.recordId === original.id)!;
      const placement = reference.tools.find(row => row.layoutIndex === tool.layoutIndex)!;
      for (const expected of original.parts) {
        const part = tool.parts.find(candidate => {
          if ((candidate.role === 'wire') !== (expected.type === 'WireframeGeometry')) return false;
          const matrix = model.batches[candidate.batchIndex].mesh.thinInstances!.matrices;
          const offset = candidate.instanceIndex * 16;
          const x = matrix[offset + 12] - placement.position[0], z = matrix[offset + 14] - placement.position[2];
          const cos = Math.cos(placement.rotation), sin = Math.sin(placement.rotation);
          return [cos * x - sin * z, matrix[offset + 13] - placement.position[1], sin * x + cos * z]
            .every((value, axis) => Math.abs(value - expected.position[axis]) < 1e-5);
        })!;
        expect(part, `${original.id}:${expected.type}:${expected.position}`).toBeDefined();
        const mesh = model.batches[part.batchIndex].mesh;
        const positions = getMeshGeometry(mesh)!.positions;
        const local: number[][] = [];
        for (let i = 0; i < positions.length; i += 3) local.push(Array.from(positions.subarray(i, i + 3)));
        if (expected.type === 'WireframeGeometry') {
          const edges = (vertices: number[][]) => {
            const result: string[] = [];
            for (let i = 0; i < vertices.length; i += 2) result.push([key(vertices[i]), key(vertices[i + 1])].sort().join('|'));
            return result.sort();
          };
          expect(edges(local)).toEqual(edges(expected.points));
        } else {
          expect([...new Set(local.map(key))].sort()).toEqual([...new Set(expected.points.map(key))].sort());
          const material = mesh.material as PbrMaterialProps;
          expect(material.baseColorFactor![3]).toBe(expected.alpha);
          expect(material.metallicFactor).toBe(expected.metallic);
          expect(material.roughnessFactor).toBe(expected.roughness);
          if (expected.type !== 'CylinderGeometry') expected.color.forEach((value, axis) =>
            expect(material.baseColorFactor![axis]).toBeCloseTo(value, 7));
        }
      }
    }
  } finally { disposeScene(scene); }
});
