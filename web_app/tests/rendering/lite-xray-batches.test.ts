import { beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));

// GPU texture upload cannot run under Node; static geometry/materials, batch identity and the
// X-Ray palette state machine remain real (same boundary as lite-static-structure.test.ts).
const textureGpu = vi.hoisted(() => ({ live: new Set<object>(), upload: vi.fn() }));
vi.mock('@babylonjs/lite', async importOriginal => ({
  ...await importOriginal<typeof import('@babylonjs/lite')>(),
  createDynamicTexture: (_engine: unknown, width: number, height: number) => {
    const texture = { width, height, texture: { destroy() { textureGpu.live.delete(texture); } }, view: {}, sampler: {} };
    textureGpu.live.add(texture); return texture;
  },
  updateDynamicTexture: textureGpu.upload,
}));

import { createSceneContext, disposeScene, getShaderUniform,
  type EngineContext, type Mesh, type ShaderMaterial } from '@babylonjs/lite';
import { createLiteStaticStructure } from '../../src/rendering/lite/geometry/static-structure';
import { createLiteEffects } from '../../src/rendering/lite/effects/index';
import { liteXraySystemMatches } from '../../src/rendering/lite/effects-xray-state';

/**
 * A06 cross-system acceptance: build the real packed static structure and the real X-Ray
 * effects module, apply the UPW filter at the effects boundary and assert the rendered batch
 * materials. This is the consumer that used to classify a CDA valve batch (carrying H-UPW
 * instances) by the first entity name and ghost the 12 real H-UPW valve parts.
 */
function harness() {
  const engine = { _renderingContexts: [], _device: {
    queue: { writeBuffer() {} },
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size);
      return { getMappedRange: () => data, unmap() {}, destroy() {} };
    },
    createSampler: () => ({}),
    createTexture: () => ({ width: 2048, height: 2048, createView: () => ({}), destroy() {} }),
  } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }) });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const structure = createLiteStaticStructure(scene, engine);
  const effects = createLiteEffects(scene, engine);
  return { engine, scene, structure, effects,
    dispose() { effects.dispose(); structure.dispose(); disposeScene(scene); vi.unstubAllGlobals(); } };
}
function xrayParams(mesh: Mesh): number[] {
  return Array.from(getShaderUniform(mesh.material as ShaderMaterial, 'xrayParams') as Float32Array);
}
const HIGHLIGHTED = [1, 1, 1, expect.closeTo(1.8)];
const ALL_HIGHLIGHTED = [1, expect.closeTo(0.55), 1, expect.closeTo(1.8)];
const GHOSTED = [1, expect.closeTo(0.15), 0, expect.closeTo(1.8)];

beforeEach(() => { textureGpu.live.clear(); textureGpu.upload.mockReset(); });

it('highlights exactly the UPW-classified subfab batches for the UPW X-Ray filter', () => {
  const h = harness();
  try {
    const b1Meshes = [...new Set(h.structure.parts.filter(part => part.layer === 'b1').map(part => part.mesh))];
    h.effects.configureXrayTargets(b1Meshes.map(mesh => ({ mesh, role: 'subfab' as const })));
    h.effects.setXrayFilter('upw');
    // Real data: every batch is classified by its own first-entity name, so the filter decision
    // observed on the rendered material matches each instance's source name.
    for (const part of h.structure.parts.filter(part => part.layer === 'b1')) {
      expect(xrayParams(part.mesh), part.name)
        .toEqual(liteXraySystemMatches(part.mesh.name, 'upw') ? HIGHLIGHTED : GHOSTED);
    }
    const upwValve = h.structure.parts.filter(part => /H-UPW-valve-\d+-(wheel|stem)$/.test(part.name));
    expect(upwValve).toHaveLength(12);
    const upwMeshes = new Set(upwValve.map(part => part.mesh));
    expect(upwMeshes.size).toBe(2);
    for (const part of upwValve) expect(xrayParams(part.mesh), part.name).toEqual(HIGHLIGHTED);
    const cdaValve = h.structure.parts.filter(part => /CDA-valve-\d+-(wheel|stem)$/.test(part.name));
    expect(cdaValve).toHaveLength(12);
    for (const part of cdaValve) {
      expect(upwMeshes.has(part.mesh), part.name).toBe(false);
      expect(xrayParams(part.mesh), part.name).toEqual(GHOSTED);
    }
    // Every non-UPW subfab batch stays ghosted, so no non-UPW instance is misclassified high.
    for (const mesh of b1Meshes) {
      if (liteXraySystemMatches(mesh.name, 'upw')) continue;
      expect(xrayParams(mesh), mesh.name).toEqual(GHOSTED);
    }
    // 'all' highlights every subfab batch; the classification key did not drop any instance.
    h.effects.setXrayFilter('all');
    for (const part of h.structure.parts.filter(part => part.layer === 'b1')) expect(xrayParams(part.mesh), part.name).toEqual(ALL_HIGHLIGHTED);
    expect(h.structure.parts).toHaveLength(1648);
  } finally { h.dispose(); }
});

it('keeps the CDA/H-UPW split across every utility filter at the rendered batch boundary', () => {
  const h = harness();
  try {
    const b1Meshes = [...new Set(h.structure.parts.filter(part => part.layer === 'b1').map(part => part.mesh))];
    h.effects.configureXrayTargets(b1Meshes.map(mesh => ({ mesh, role: 'subfab' as const })));
    for (const filter of ['gas', 'vac', 'exhaust', 'amhs'] as const) {
      h.effects.setXrayFilter(filter);
      for (const part of h.structure.parts.filter(part => part.layer === 'b1')) {
        const active = filter === 'amhs' ? false : liteXraySystemMatches(part.mesh.name, filter);
        expect(xrayParams(part.mesh), part.name + ':' + filter).toEqual(active ? HIGHLIGHTED : GHOSTED);
      }
    }
  } finally { h.dispose(); }
});
