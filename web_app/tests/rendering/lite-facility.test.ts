import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 } }));
import { createSceneContext, disposeScene, getMeshGeometry, type EngineContext } from '@babylonjs/lite';
import reference from '../fixtures/lite-facility-reference.json';
import { createLiteFacility } from '../../src/rendering/lite/geometry/facility';

// The frozen reference was extracted from the legacy CPU scene before the P11 renderer
// source removal (see provenance); the native Lite port must keep every source part
// name and exact source-space bounds without loading the old engine.
it('restores every frozen source airlock/mat/FFU geometric part at its exact source bounds', () => {
  const engine = { _renderingContexts: [], _device: { createBuffer({ size }: { size: number }) { const data = new ArrayBuffer(size);
    return { getMappedRange: () => data, unmap() {}, destroy() {} }; } } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const model = createLiteFacility(scene, engine);
  try {
    expect(model.parts).toHaveLength(reference.parts.length);
    expect(model.airShowers.map(group => [group.name, group.position.x, group.position.z])).toEqual(reference.airShowers);
    for (const frozen of reference.parts) {
      const part = model.parts.find(candidate => candidate.name === frozen.name);
      expect(part, frozen.name).toBeTruthy();
      const data = getMeshGeometry(part!.mesh)!.positions, m = part!.mesh.worldMatrix;
      const thin = part!.mesh.thinInstances?.matrices, offset = part!.instanceIndex * 16;
      const points: number[][] = [];
      for (let i = 0; i < data.length; i += 3) {
        const p = Array.from(data.subarray(i, i + 3));
        const local = thin ? [0, 1, 2].map(a => thin[offset+a]*p[0]+thin[offset+a+4]*p[1]+thin[offset+a+8]*p[2]+thin[offset+a+12]) : p;
        points.push([0, 1, 2].map(a => m[a]*local[0]+m[a+4]*local[1]+m[a+8]*local[2]+m[a+12]));
      }
      [0, 1, 2].forEach(a => {
        expect(Math.min(...points.map(p => p[a])), frozen.name + ':min').toBeCloseTo(frozen.min[a], 4);
        expect(Math.max(...points.map(p => p[a])), frozen.name + ':max').toBeCloseTo(frozen.max[a], 4);
      });
    }
    expect(model.ceiling.visible).toBe(reference.ceilingVisibleByDefault);
    model.setCeilingVisible(true); expect(model.ceiling.visible).toBe(true);
    expect(model.lights).toHaveLength(reference.lightCount);
  } finally { model.dispose(); disposeScene(scene); }
});
