import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));
import { addToScene, createBox, createCsmDirectionalShadowGenerator, createDirectionalLight,
  createLineMaterial, createLines, createPbrMaterial, createSceneContext, disposeScene,
  getCsmReceiverTexture, getMeshGeometry, getMeshIndexedDrawInfo, getShaderTexture, getShaderUniform,
  type EngineContext, type ShaderMaterial } from '@babylonjs/lite';
import { createLiteEffects } from '../src/rendering/lite/effects';
import { liteXraySurfaceState, liteXraySystemMatches } from '../src/rendering/lite/effects-xray-state';

function harness() {
  const buffers: { destroyed: boolean; size: number }[] = [];
  const writes: unknown[] = [];
  const engine = { _renderingContexts: [], _device: {
    queue: { writeBuffer(...args: unknown[]) { writes.push(args); } },
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size), buffer = { destroyed: false, size,
        getMappedRange: () => data, unmap() {}, destroy() { buffer.destroyed = true; } };
      buffers.push(buffer); return buffer;
    },
    createSampler: () => ({}),
    createTexture: () => ({ width: 2048, height: 2048, createView: () => ({}), destroy() {} }),
  } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const effects = createLiteEffects(scene, engine);
  return { effects, scene, engine, writes, buffers, dispose() { effects.dispose(); disposeScene(scene); } };
}

it('matches the literal source matrix for every surface role and all six filters', () => {
  const filters = ['all', 'upw', 'gas', 'vac', 'exhaust', 'amhs'] as const;
  const expected = {
    equipment: [[.16, 0, 2.2], [.16, 0, 2.2], [.16, 0, 2.2], [.16, 0, 2.2], [.16, 0, 2.2], [.16, 0, 2.2]],
    floor: [[.12, 0, 1.6], [.12, 0, 1.6], [.12, 0, 1.6], [.12, 0, 1.6], [.12, 0, 1.6], [.12, 0, 1.6]],
    subfab: [[.55, 1, 1.8], [1, 1, 1.8], [1, 1, 1.8], [1, 1, 1.8], [1, 1, 1.8], [.15, 0, 1.8]],
    oht: [[.25, 0, 2], [.25, 0, 2], [.25, 0, 2], [.25, 0, 2], [.25, 0, 2], [.9, 1, 1.8]],
  };
  for (const role of ['equipment', 'floor', 'subfab', 'oht'] as const) filters.forEach((filter, i) => {
    expect(Object.values(liteXraySurfaceState(role, filter, true))).toEqual(expected[role][i]);
    if (role === 'subfab' && i > 0 && i < 5)
      expect(Object.values(liteXraySurfaceState(role, filter, false))).toEqual([.15, 0, 1.8]);
  });
  for (const name of ['subfab-vac-pipe', 'subfab-pump-0', 'subfab-booster-2']) expect(liteXraySystemMatches(name, 'vac')).toBe(true);
  for (const name of ['subfab-foreline', 'subfab-heated', 'subfab-exhaust']) expect(liteXraySystemMatches(name, 'exhaust')).toBe(true);
  expect(liteXraySystemMatches('subfab-upw-main', 'upw')).toBe(true);
  expect(liteXraySystemMatches('subfab-gas-main', 'gas')).toBe(true);
  expect(liteXraySystemMatches('equipment-gas', 'gas')).toBe(false);
  expect(liteXraySystemMatches('native-oht-1', 'amhs')).toBe(true);
});

it('restores exact material references and caster metadata after rapid filter/target changes', () => {
  const h = harness();
  try {
    const equipment = createBox(h.engine), subfab = createBox(h.engine), floor = createBox(h.engine);
    equipment.material = createPbrMaterial(); subfab.material = createPbrMaterial(); floor.material = createPbrMaterial();
    const originals = [equipment.material, subfab.material, floor.material];
    equipment.metadata = { stable: 'identity', xrayCaster: false };
    subfab.name = 'subfab-pump-0';
    for (const mesh of [equipment, subfab, floor]) addToScene(h.scene, mesh);
    h.effects.configureXrayTargets([{ mesh: equipment, role: 'equipment' }, { mesh: subfab, role: 'subfab' }, { mesh: floor, role: 'floor' }]);
    for (const filter of ['all', 'gas', 'vac', 'amhs', 'upw', 'exhaust'] as const) h.effects.setXrayFilter(filter);
    expect(Array.from(getShaderUniform(subfab.material as ShaderMaterial, 'xrayParams') as Float32Array)).toEqual([1, expect.closeTo(.15), 0, expect.closeTo(1.8)]);
    expect(equipment.metadata).toEqual({ stable: 'identity', xrayCaster: true });
    h.effects.configureXrayTargets([{ mesh: subfab, role: 'subfab' }]);
    expect(equipment.material).toBe(originals[0]); expect(floor.material).toBe(originals[2]);
    expect(equipment.metadata).toEqual({ stable: 'identity', xrayCaster: false });
    h.effects.setXrayFilter(null); h.effects.setXrayFilter(null);
    expect(subfab.material).toBe(originals[1]); expect(subfab.metadata?.xrayCaster).toBeUndefined();
    h.effects.setXrayFilter('vac'); h.effects.dispose();
    expect(subfab.material).toBe(originals[1]);
  } finally { h.dispose(); }
});

it('uses the same native hologram sources for catalog lines and triangles and restores lines exactly', () => {
  const h = harness();
  try {
    const lineMaterial = createLineMaterial();
    const line = createLines(h.engine, { name: 'catalog-wire', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], material: lineMaterial });
    const box = createBox(h.engine); box.material = createPbrMaterial();
    h.effects.configureXrayTargets([{ mesh: line, role: 'equipment' }, { mesh: box, role: 'equipment' }]);
    h.effects.setXrayFilter('all');
    const lm = line.material as ShaderMaterial, bm = box.material as ShaderMaterial;
    expect(lm.vertexSource).toBe(bm.vertexSource); expect(lm.fragmentSource).toBe(bm.fragmentSource);
    expect(Array.from(getShaderUniform(lm, 'xrayParams') as Float32Array)).toEqual([1, .75, 0, expect.closeTo(1.4)]);
    expect(lm.vertexSource).toContain('getFinalWorld(input)');
    h.effects.setXrayFilter(null); expect(line.material).toBe(lineMaterial);
  } finally { h.dispose(); }
});

it('reflects only the cut normal Z, clamps source position, and clips every effects shader', () => {
  const h = harness();
  try {
    h.effects.setCutPlane(true, 'Z', 12, false); expect(h.scene.clipPlane).toEqual([0, 0, -1, -12]);
    h.effects.setCutPlane(true, 'Z', -100, true); expect(h.scene.clipPlane).toEqual([0, 0, 1, -60]);
    h.effects.setCutPlane(true, 'X', 100, true); expect(h.scene.clipPlane).toEqual([-1, 0, 0, 60]);
    h.effects.setCutPlane(true, 'Y', 4, false); expect(h.scene.clipPlane).toEqual([0, 1, 0, -4]);
    const mesh = createBox(h.engine); mesh.material = createPbrMaterial();
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]); h.effects.setXrayFilter('all');
    expect(Array.from(getShaderUniform(mesh.material as ShaderMaterial, 'cutPlane') as Float32Array)).toEqual([0, 1, 0, -4]);
    expect((mesh.material as ShaderMaterial).fragmentSource).toContain('discard');
    h.effects.setCutPlane(false, 'Z', 0, false); expect(h.scene.clipPlane).toBeNull();
    expect(Array.from(getShaderUniform(mesh.material as ShaderMaterial, 'cutPlane') as Float32Array)).toEqual([0, 0, 0, 0]);
  } finally { h.dispose(); }
});

it('retains the source marker parts, source RH motion and parented amber point light', () => {
  const h = harness();
  try {
    const meshes = h.effects.meshes;
    const marker = meshes.find(m => m.name === 'wafer-follow-marker')!;
    const flange = meshes.find(m => m.name === 'wafer-follow-flange-mesh')!;
    const door = meshes.find(m => m.name === 'wafer-follow-door-mesh')!;
    for (const [mesh, dimensions] of [[marker, [.5, .35, .4]], [flange, [.12, .04, .12]], [door, [.44, .3, .012]]] as const) {
      const positions = getMeshGeometry(mesh)!.positions;
      dimensions.forEach((size, axis) => {
        const values = Array.from(positions).filter((_, i) => i % 3 === axis);
        expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(size, 6);
      });
    }
    expect(marker.parent).toBe(h.effects.root); expect(flange.parent).toBe(marker); expect(door.parent).toBe(marker);
    expect(flange.position.y).toBe(.195); expect(door.position.z).toBe(.201);
    expect(marker.visible).toBe(false); expect(flange.visible).toBe(false); expect(door.visible).toBe(false);
    expect(h.effects.lights).toHaveLength(1);
    const light = h.effects.lights[0]; expect(light.parent).toBe(marker); expect(light.position.y).toBe(.3);
    expect(light.range).toBe(4); expect(light.diffuse).toEqual([245 / 255, 158 / 255, 11 / 255]);
    h.effects.setWaferPoint(1, 2, 3, true);
    expect(marker.position).toMatchObject({ x: 1, y: 2, z: 3 }); expect(marker.rotation.y).toBeCloseTo(Math.atan2(1, 3));
    expect(light.intensity).toBe(.9);
    h.effects.setWaferPoint(2, 4, 5, true, .7); expect(marker.rotation.y).toBeCloseTo(.7);
    h.effects.setWaferPoint(2, 4, 5, true); expect(marker.rotation.y).toBeCloseTo(.7);
    h.effects.setWaferPoint(0, 0, 0, false); expect(light.intensity).toBe(0); expect(door.visible).toBe(false);
  } finally { h.dispose(); }
});

it('bounds the additive trail to 30 retained vertices and skips unchanged uploads while catching interior changes', () => {
  const h = harness();
  try {
    const trail = h.effects.meshes.find(m => m.name === 'wafer-follow-trail')!;
    expect(trail.visible).toBe(false);
    const points = Array.from({ length: 40 }, (_, i) => [i, i * .1, -i] as const);
    const allocationCount = h.buffers.length;
    h.effects.setWaferTrail(points);
    expect(h.buffers).toHaveLength(allocationCount);
    expect(getMeshGeometry(trail)!.positions.length).toBe(90);
    expect(Array.from(getMeshGeometry(trail)!.positions).slice(-3)).toEqual([29, expect.closeTo(2.9), -29]);
    expect(getMeshIndexedDrawInfo(trail).indexCount).toBe(58);
    expect((trail.material as ShaderMaterial).blendMode).toBe('additive');
    const writes = h.writes.length; h.effects.setWaferTrail(points); expect(h.writes).toHaveLength(writes);
    h.effects.setWaferTrail(points.map((p, i) => i === 1 ? [50, 2, 3] as const : p)); expect(h.writes.length).toBeGreaterThan(writes);
    h.effects.setWaferTrail([[1, 2, 3], [4, 5, 6]]); expect(getMeshIndexedDrawInfo(trail).indexCount).toBe(2);
    expect(Array.from(getMeshGeometry(trail)!.positions).slice(-3)).toEqual([4, 5, 6]);
    h.effects.setWaferTrail([]); expect(trail.visible).toBe(false);
    h.effects.setWaferTrail([[1, 2, 3], [4, 5, 6]]);
    expect(trail.visible).toBe(true); expect(h.buffers).toHaveLength(allocationCount);
  } finally { h.dispose(); }
  expect(h.buffers.every(b => b.destroyed)).toBe(true);
});

it('borrows the native CSM receiver texture without taking texture ownership', () => {
  const h = harness();
  try {
    const light = createDirectionalLight([0, -1, 0]); addToScene(h.scene, light);
    const generator = createCsmDirectionalShadowGenerator(h.engine, light, { numCascades: 2, mapSize: 2048 });
    light.shadowGenerator = generator; h.scene.shadowGenerators.push(generator);
    const mesh = createBox(h.engine); mesh.material = createPbrMaterial();
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]); h.effects.bindShadows(generator); h.effects.setXrayFilter('all');
    const material = mesh.material as ShaderMaterial;
    expect(getShaderTexture(material, 'xrayDepth')).toBe(getCsmReceiverTexture(generator));
    h.effects.update(16, 1000); expect(getShaderTexture(material, 'xrayDepth')).toBe(getCsmReceiverTexture(generator));
  } finally { h.dispose(); }
});

it('skips the X-Ray palette CSM fan-out while inactive and resyncs the retained receiver on re-enable', () => {
  const h = harness();
  try {
    const light = createDirectionalLight([0, -1, 0]); addToScene(h.scene, light);
    const generator = createCsmDirectionalShadowGenerator(h.engine, light, { numCascades: 2, mapSize: 2048 });
    light.shadowGenerator = generator; h.scene.shadowGenerators.push(generator);
    const mesh = createBox(h.engine); mesh.material = createPbrMaterial(); addToScene(h.scene, mesh);
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]);
    h.effects.bindShadows(generator);
    h.effects.setXrayFilter('all');
    const palette = mesh.material as ShaderMaterial;
    const version = (material: ShaderMaterial) => (material as unknown as { _uniformVersion: number })._uniformVersion;
    const publish = (data: Float32Array) => {
      const callbacks = (generator as unknown as { _onReceiverData?: ((data: Float32Array) => void)[] })._onReceiverData ?? [];
      expect(callbacks.length).toBeGreaterThan(0);
      for (const callback of callbacks) callback(data);
    };

    // While X-Ray is active the borrowed CSM receiver UBO reaches the palette material.
    const activeData = new Float32Array(80).fill(0.25);
    publish(activeData);
    expect(Array.from(getShaderUniform(palette, 'xrayCascade0') as Float32Array)).toEqual(Array.from(activeData.subarray(0, 16)));
    expect(getShaderUniform(palette, 'xrayShadowEnabled')).toBe(1);

    h.effects.setXrayFilter(null);
    expect(mesh.material).not.toBe(palette);
    const inactiveVersion = version(palette);
    // B04: no rendered mesh uses the palette while X-Ray is off, so a receiver publish must
    // not fan 80 floats / eight uniform writes into every retained palette material.
    publish(new Float32Array(80).fill(0.5));
    expect(version(palette)).toBe(inactiveVersion);

    // Re-enabling re-applies the retained receiver snapshot before the first active frame.
    h.effects.setXrayFilter('all');
    expect(mesh.material).toBe(palette);
    expect(Array.from(getShaderUniform(palette, 'xrayCascade0') as Float32Array)).toEqual(new Array(16).fill(0.5));
    expect(getShaderUniform(palette, 'xrayShadowEnabled')).toBe(1);
    expect(version(palette)).toBeGreaterThan(inactiveVersion);

    // The active cadence is unchanged after the resync.
    const afterResync = version(palette);
    publish(new Float32Array(80).fill(0.75));
    expect(Array.from(getShaderUniform(palette, 'xrayCascade2') as Float32Array)).toEqual(new Array(16).fill(0.75));
    expect(version(palette)).toBeGreaterThan(afterResync);
  } finally { h.dispose(); }
});
