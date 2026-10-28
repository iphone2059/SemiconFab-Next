import { afterEach, expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 } }));
vi.mock('@babylonjs/lite', async importOriginal => {
  const actual = await importOriginal<typeof import('@babylonjs/lite')>();
  return { ...actual,
    createDynamicTexture: vi.fn((_engine, width, height) => ({ width, height })),
    updateDynamicTexture: vi.fn(), releaseTexture: vi.fn(), addFacingBillboardSystem: vi.fn(),
    updateBillboardSpriteIndex: vi.fn(actual.updateBillboardSpriteIndex),
  };
});
import { addFacingBillboardSystem, createSceneContext, getMeshGeometry, releaseTexture, updateBillboardSpriteIndex, updateDynamicTexture, type EngineContext } from '@babylonjs/lite';
import { createLiteEnvironment } from '../../src/rendering/lite/environment';
import { advanceLaminarParticle, cleanroomPressureField } from '../../src/domain/fab/cleanroom-pressure';
import { FAB_LAYOUT } from '../../src/domain/fab/fab-layout';
import { ORIGINAL_EXPLODED_LINKS, explodedLinkFrame } from '../../src/rendering/lite/geometry/original-exploded-link-data';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function fixture() {
  const draw = vi.fn();
  const context = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }) }, {
    get(target, key) { return key in target ? target[key as keyof typeof target] : draw; }, set() { return true; },
  });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
  const engine = { _renderingContexts: [], _device: { createBuffer({ size }: { size: number }) {
    const data = new ArrayBuffer(size); return { getMappedRange: () => data, unmap() {}, destroy() {} };
  } } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  return { scene, model: createLiteEnvironment(scene, engine) };
}

it('builds the complete source roof, native particle batches, heatmap and twelve links in RH coordinates', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { scene, model } = fixture();
  expect(model.meshes).toHaveLength(73);
  expect(model.meshes.every(mesh => scene.meshes.includes(mesh))).toBe(true);
  const slab = model.meshes.find(mesh => mesh.name === 'original-roof-slab')!;
  expect([slab.position.x, slab.position.y, slab.position.z]).toEqual([4.5, 8, 1]);
  expect(model.meshes.filter(mesh => mesh.name?.startsWith('original-roof-supply-drop-'))).toHaveLength(12);
  expect(model.meshes.filter(mesh => mesh.name?.startsWith('original-roof-exhaust-stack-')).map(mesh => mesh.position.x)).toEqual([-25, -10, 5, 20, 35]);
  expect(model.billboardSystems.map(system => system.count)).toEqual([70, 1500, 1, 1, 1]);
  expect(model.roofRoot.visible).toBe(false); expect(model.airflowRoot.visible).toBe(false); expect(model.heatmapRoot.visible).toBe(false);
  expect(model.diagnostics.roofParticles).toHaveLength(70);
  expect(model.diagnostics.roofParticles[0]).toMatchObject({ x: -25.175, y: 13.2, z: 27, speed: 0.025 });
  expect(model.diagnostics.labels.map(label => label.position)).toEqual([[-20, 12.45, -20], [5, 12.45, -20], [30, 12.45, -20]]);
  model.setLayer('roof', true); model.setLayer('airflow', true); model.setLayer('heatmap', true);
  expect(model.billboardSystems.every(system => system.visible)).toBe(true);
  model.dispose(); vi.restoreAllMocks();
});

it('retains the exact seeded 1500-particle generator and pressure update, including hidden-layer clocks', () => {
  const { model } = fixture();
  let seed = 0x464142;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const source = Array.from({ length: 1500 }, () => {
    const x = -46 + random() * 92, z = -34 + random() * 68, y = 0.05 + random() * 7.85;
    return { x, y, z, vy: (x <= -16.5 && z <= 4.5 ? 0.046 : 0.036) + (random() - 0.5) * 0.008 };
  });
  expect(model.diagnostics.airflowParticles.map(({ x, y, z, vy }) => ({ x, y, z, vy }))).toEqual(source);
  model.update(1000, 1000); expect(model.diagnostics.airflowClock).toBe(0);
  model.setLayer('airflow', true);
  const obstacles = FAB_LAYOUT.map(t => ({ x: t.x, z: t.z, halfW: t.width / 2 + 0.35, halfL: t.depth / 2 + 0.35, topY: t.height }));
  for (let tick = 0; tick < 190; tick++) {
    for (const particle of source) advanceLaminarParticle(particle, 0.016, obstacles, random);
    model.update(16, 1016 + tick * 16);
  }
  expect(model.diagnostics.airflowParticles.map(({ x, y, z, vy }) => ({ x, y, z, vy }))).toEqual(source);
  model.setLayer('airflow', false); const y = model.diagnostics.airflowParticles[0].y;
  model.setLayer('heatmap', true); model.update(1000, 6000);
  expect(model.diagnostics.airflowParticles[0].y).toBe(y);
  expect(model.diagnostics.airflowClock).toBeCloseTo(190 * 0.016 + 0.05);
  model.dispose();
});

it('keeps the original post-move pressure-band colour semantics on every airflow frame', () => {
  const { model } = fixture();
  // Rebuild the frozen seeded generator and motion stream exactly as the environment does.
  let seed = 0x464142;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const source = Array.from({ length: 1500 }, () => {
    const x = -46 + random() * 92, z = -34 + random() * 68, y = 0.05 + random() * 7.85;
    return { x, y, z, vy: (x <= -16.5 && z <= 4.5 ? 0.046 : 0.036) + (random() - 0.5) * 0.008 };
  });
  const obstacles = FAB_LAYOUT.map(t => ({ x: t.x, z: t.z, halfW: t.width / 2 + 0.35, halfL: t.depth / 2 + 0.35, topY: t.height }));
  const lithoColor = [0.98, 0.75, 0.14, 0.72], airlockColor = [0.98, 0.55, 0.2, 0.72], bayColor = [0.22, 0.74, 0.98, 0.72];
  // The original implementation recoloured from the pressure field sampled AFTER the move.
  const originalColor = (particle: { x: number; z: number }) => {
    const field = cleanroomPressureField(particle.x, particle.z);
    return field.pressure >= 26 ? lithoColor : field.isAirlock ? airlockColor : bayColor;
  };
  model.setLayer('airflow', true);
  expect(model.diagnostics.airflowParticles.map(particle => particle.patch.color)).toEqual(source.map(originalColor));
  let dtSeed = 0x2545f491;
  const dtRandom = () => { dtSeed = (Math.imul(dtSeed, 1664525) + 1013904223) >>> 0; return dtSeed / 0x100000000; };
  const deltas = Array.from({ length: 40 }, () => Math.round(dtRandom() * 1200) - 60);
  const bands = new Set<string>();
  let transitions = 0, mismatch: { frame: number; index: number } | null = null;
  for (let frame = 0; frame < 300 && !mismatch; frame++) {
    const deltaMs = deltas[frame % deltas.length];
    const dt = Number.isFinite(deltaMs) ? Math.min(0.05, Math.max(0, deltaMs / 1000)) : 0;
    for (const particle of source) advanceLaminarParticle(particle, dt, obstacles, random);
    const previous = model.diagnostics.airflowParticles.map(particle => particle.patch.color);
    model.update(deltaMs, 1000 + frame * 16);
    for (let index = 0; index < source.length; index++) {
      const expected = originalColor(source[index]);
      const actual = model.diagnostics.airflowParticles[index].patch.color;
      if (!actual || actual[0] !== expected[0] || actual[1] !== expected[1]
        || actual[2] !== expected[2] || actual[3] !== expected[3]) {
        mismatch = { frame, index };
        break;
      }
      bands.add(expected.join(','));
      if (previous[index] !== actual) transitions++;
    }
  }
  expect(mismatch).toBeNull();
  expect(model.diagnostics.airflowParticles.map(({ x, y, z, vy }) => ({ x, y, z, vy }))).toEqual(source);
  expect(bands.size).toBe(3);
  expect(transitions).toBeGreaterThan(0);
  model.dispose();
});

it('advances exhaust only on visible nominal source frames and preserves exploded identity and pulse timing', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { model } = fixture();
  model.update(1000, 1000); expect(model.diagnostics.roofParticles[0].y).toBe(13.2);
  model.setLayer('roof', true); model.update(16, 2000); model.update(1000, 3000);
  let expectedY = 13.2;
  for (let frame = 0; frame < Math.floor(1000 / (1000 / 60)); frame++) expectedY = expectedY + 0.025 > 14.5 ? 12.3 : expectedY + 0.025;
  expect(model.diagnostics.roofParticles[0].y).toBeCloseTo(expectedY);
  model.setLayer('roof', false); model.update(1000, 4000);
  model.setLayer('roof', true); model.update(1000, 5000);
  expect(model.diagnostics.roofParticles[0].y).toBeCloseTo(expectedY);
  model.setExplodeFactor(0.5); model.update(0, 5000);
  ORIGINAL_EXPLODED_LINKS.forEach((record, index) => {
    const mesh = model.meshes.find(mesh => mesh.name === 'original-interconnect-' + record.subId)!;
    const frame = explodedLinkFrame(0.5, 5000, ((index * 1664525 + 1013904223) >>> 0) / 2 ** 32 * Math.PI * 2);
    expect(mesh.metadata).toMatchObject({ connectedTool: record.hostId, subTool: record.subId });
    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([(record.hostX + record.subX) / 2, frame.y, (record.hostZ + record.subZ) / 2]);
    expect(mesh.scaling.y).toBe(frame.scaleY);
  });
  model.setExplodeFactor(NaN); expect(model.linksRoot.visible).toBe(false);
  model.update(10000, 15000);
  for (let frame = 0; frame < 120; frame++) expectedY = expectedY + 0.025 > 14.5 ? 12.3 : expectedY + 0.025;
  expect(model.diagnostics.roofParticles[0].y).toBeCloseTo(expectedY);
  model.update(1, 15001); expect(model.diagnostics.roofParticles[0].y).toBeCloseTo(expectedY);
  model.dispose(); vi.restoreAllMocks();
});

it('updates bilingual canvases, leaves billboard registration to its native scene owner, and releases creator claims exactly once', () => {
  const { model } = fixture();
  expect(addFacingBillboardSystem).not.toHaveBeenCalled();
  const initialUpdates = vi.mocked(updateDynamicTexture).mock.calls.length;
  model.setLanguage('en'); expect(vi.mocked(updateDynamicTexture).mock.calls.length).toBe(initialUpdates + 3);
  expect(model.diagnostics.labels.every(label => label.language === 'en')).toBe(true);
  model.setLayer('roof', true); model.setLayer('airflow', true);
  expect(model.roofRoot.visible).toBe(true); expect(model.airflowRoot.visible).toBe(true);
  const count = model.billboardSystems.reduce((sum, system) => sum + system.count, 0);
  expect(count).toBe(1573);
  model.dispose(); model.dispose(); expect(releaseTexture).toHaveBeenCalledTimes(6);
  expect(model.billboardSystems.every(system => !system.visible)).toBe(true);
  const uploads = vi.mocked(updateDynamicTexture).mock.calls.length;
  model.setLanguage('zh'); model.setLayer('heatmap', true); model.update(1000, 1000);
  expect(vi.mocked(updateDynamicTexture).mock.calls.length).toBe(uploads);
});

it('uses the declared native sampler identifier and standalone fragment inputs for the transparent pressure map', () => {
  const { model } = fixture();
  const material = model.meshes.find(mesh => mesh.name === 'airflowHeatmap')!.material as import('@babylonjs/lite').ShaderMaterial;
  expect(material.fragmentSource).toContain('textureSample(heatmap,heatmapSampler,');
  expect(material.fragmentSource).not.toContain('VertexOutput');
  expect(material.depthWrite).toBe(false);
  expect(material.depthBias).toBe(-4);
  const slab = model.meshes.find(mesh => mesh.name === 'original-roof-slab')!;
  expect(slab.metadata?.staticShadowCaster).not.toBe(false);
  model.dispose();
});

it('releases the dynamic texture creator claim when the first source upload fails', () => {
  vi.mocked(updateDynamicTexture).mockImplementationOnce(() => { throw new Error('source upload failed'); });
  expect(() => fixture()).toThrow('source upload failed');
  expect(releaseTexture).toHaveBeenCalledTimes(1);
});

it('matches the frozen source dimensions and world bounds for slab, MAUs, ducts, and stacks', () => {
  const { model } = fixture();
  const bounds = (name: string, minimum: number[], maximum: number[]) => {
    const mesh = model.meshes.find(row => row.name === name)!;
    const positions = getMeshGeometry(mesh)!.positions, m = mesh.worldMatrix;
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      const value = m[axis] * positions[i] + m[axis + 4] * positions[i + 1] + m[axis + 8] * positions[i + 2] + m[axis + 12];
      low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
    }
    for (let axis = 0; axis < 3; axis++) {
      expect(low[axis], name + ':minimum').toBeCloseTo(minimum[axis], 5);
      expect(high[axis], name + ':maximum').toBeCloseTo(maximum[axis], 5);
    }
  };
  bounds('original-roof-slab', [-38, 7.85, -29], [47, 8.15, 31]);
  bounds('original-roof-parapet-north', [-38, 8.125, -29.15], [47, 8.575, -28.85]);
  bounds('original-roof-parapet-south', [-38, 8.125, 30.85], [47, 8.575, 31.15]);
  bounds('original-roof-parapet-west', [-38.15, 8.125, -29], [-37.85, 8.575, 31]);
  bounds('original-roof-parapet-east', [46.85, 8.125, -29], [47.15, 8.575, 31]);
  [-20, 5, 30].forEach((x, i) => {
    const name = `original-roof-mau-${i + 1}`;
    bounds(name + '-body', [x - 3, 8.15, -22], [x + 3, 11.15, -18]);
    bounds(name + '-curb', [x - 3.2, 8.15, -22.2], [x + 3.2, 8.35, -17.8]);
    [-1.6, 1.6].forEach((offset, cowl) => bounds(name + '-cowl-' + (cowl + 1),
      [x + offset - 0.7, 11.15, -20.7], [x + offset + 0.7, 11.65, -19.3]));
    bounds(name + '-louver', [x - 2.6, 8.55, -17.98], [x + 2.6, 10.75, -17.98]);
    bounds('original-roof-supply-feeder-mau-' + (i + 1), [x - 0.45, 8.3, -20], [x + 0.45, 9, 15]);
  });
  [['north', -15], ['central', 0], ['south', 15]].forEach(([name, z]) => bounds('original-roof-supply-main-' + name,
    [-36, 8.25, Number(z) - 0.6], [45, 9.05, Number(z) + 0.6]));
  [[-27.5, -15], [-27.5, 0], [-4.5, -15], [20, -15], [25.5, 15], [15.5, 15],
    [-8.5, 15], [0.5, 15], [-27.5, 15], [-27.5, 25], [39, -15], [39, 8]].forEach(([x, z], index) =>
    bounds('original-roof-supply-drop-' + index, [x - 0.375, 5.22, z - 0.375], [x + 0.375, 8.65, z + 0.375]));
  [-25, -10, 5, 20, 35].forEach((x, index) => {
    bounds('original-roof-exhaust-stack-' + (index + 1), [x - 0.5, 8.15, 26.5], [x + 0.5, 12.15, 27.5]);
    bounds('original-roof-exhaust-cowl-' + (index + 1), [x - 0.65, 12.05, 26.35], [x + 0.65, 12.35, 27.65]);
  });
  bounds('airflowHeatmap', [-47, 0.035, -35], [47, 0.035, 35]);
  model.dispose();
});

it('projects native billboard positions through the source root exactly once after reflection and layer movement', () => {
  const { model } = fixture();
  model.root.scaling.z = -1; model.roofRoot.position.y = 12; model.airflowRoot.position.y = 3;
  model.setLayer('roof', true); model.setLayer('airflow', true);
  model.update(0, 0);
  const roof = model.diagnostics.roofParticles[0], air = model.diagnostics.airflowParticles[0];
  expect(roof.patch.position).toEqual([roof.x, roof.y + 12, -roof.z]);
  expect(air.patch.position).toEqual([air.x, air.y + 3, -air.z]);
  expect(model.diagnostics.labels[0].patch.position).toEqual([-20, 24.45, 20]);
  model.dispose();
});

it('keeps hidden native billboard buffers clean while unrelated visible scene systems update', () => {
  const { model } = fixture();
  vi.mocked(updateBillboardSpriteIndex).mockClear(); model.update(16, 16);
  expect(vi.mocked(updateBillboardSpriteIndex).mock.calls.length).toBe(0);
  model.setLayer('roof', true); vi.mocked(updateBillboardSpriteIndex).mockClear(); model.update(16, 32);
  expect(updateBillboardSpriteIndex).toHaveBeenCalledTimes(73);
  model.dispose();
});
