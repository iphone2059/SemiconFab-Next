import { expect, it, vi } from 'vitest';
import { createBox, createDirectionalLight, createLineSystem, createPbrMaterial, createSceneContext,
  getCsmReceiverTexture, getTextureMetadata, type EngineContext } from '@babylonjs/lite';
import { createLiteShadows, selectLiteShadowCasters } from '../../src/rendering/lite/shadows/native-lite-shadow';

vi.hoisted(() => Object.assign(globalThis, { GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8, VERTEX: 32, INDEX: 16 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_DST: 2 } }));
function fixture() {
  const textures: GPUTextureDescriptor[] = [];
  const sampler = vi.fn(() => ({}));
  const engine = { surfaces: [], _device: {
    createBuffer({ size }: { size: number }) { const bytes = new ArrayBuffer(size); return {
      getMappedRange: () => bytes, unmap() {}, destroy() {},
    }; },
    createTexture(descriptor: GPUTextureDescriptor) { textures.push(descriptor); return {
      createView: () => ({}), destroy() {}, width: 2048, height: 2048, format: descriptor.format,
    }; },
    createSampler: sampler, queue: { writeBuffer() {} },
  } } as unknown as EngineContext;
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  return { engine, scene, textures, sampler };
}
it('selects actual source casters while excluding floor, slab, lines and noncasting status parts', () => {
  const { engine } = fixture();
  const body = createBox(engine); body.name = 'equipment-batch-0';
  const floor = createBox(engine); floor.name = 'procedural-floor';
  const slab = createBox(engine); slab.name = 'procedural-slab';
  const status = createBox(engine); status.metadata = { staticShadowCaster: false };
  const lines = createLineSystem(engine, { lines: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }]] });
  expect(selectLiteShadowCasters([body, floor, slab, status, lines])).toEqual([body]);
});
it('creates native recoverable 2048 depth-array shadows with comparison sampling and explicit light ownership', async () => {
  const { engine, scene, textures, sampler } = fixture();
  const body = createBox(engine); body.material = createPbrMaterial(); scene.meshes.push(body);
  const key = createDirectionalLight([-35, -65, 45], 1.15);
  const shadows = await createLiteShadows(scene, engine, key);
  expect(scene.shadowGenerators).toEqual([shadows.generator]);
  expect(key.shadowGenerator).toBe(shadows.generator);
  expect(textures.every(texture => texture.format === 'depth32float')).toBe(true);
  expect(textures[0].size).toMatchObject({ width: 2048, height: 2048, depthOrArrayLayers: 2 });
  expect(sampler).toHaveBeenCalledWith(expect.objectContaining({ compare: 'less' }));
  expect(getTextureMetadata(getCsmReceiverTexture(shadows.generator))?.format).toBe('depth32float');
  shadows.setEnabled(false); expect(shadows.enabled).toBe(false);
  shadows.setEnabled(true); expect(shadows.enabled).toBe(true);
});
