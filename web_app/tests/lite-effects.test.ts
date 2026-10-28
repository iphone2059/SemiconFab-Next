import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));
import { addToScene, createBox, createCsmDirectionalShadowGenerator, createDirectionalLight,
  createLineMaterial, createLines, createPbrMaterial, createSceneContext, decodeError, disposeScene,
  getCsmReceiverTexture, getMeshGeometry, getMeshIndexedDrawInfo, getShaderTexture, getShaderUniform,
  type EngineContext, type ShaderMaterial } from '@babylonjs/lite';
import { createLiteEffects } from '../src/rendering/lite/effects/index';
import { createXrayEffect } from '../src/rendering/lite/effects/xray';
import { LITE_XRAY_SHADER_PROGRAM, XRAY_GLOW, XRAY_LINE_PARAMS, XRAY_NORMAL_LINE_COLOR,
  XRAY_TINT, XRAY_ZERO_PARAMS } from '../src/rendering/lite/effects/xray-shaders';
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

// ---------------------------------------------------------------------------------------------
// R-06 effect-ownership tests: independent X-Ray / cut / wafer owners with explicit
// create/update/dispose. The golden parity assertions above stay untouched.
// ---------------------------------------------------------------------------------------------

it('declares the exact frozen X-Ray WGSL uniform / sampler / palette contract', () => {
  const customUniforms = LITE_XRAY_SHADER_PROGRAM.uniforms.flatMap(uniform =>
    typeof uniform === 'object' ? [uniform.name] : []);
  expect(customUniforms).toEqual([
    'xrayParams', 'xrayTint', 'xrayGlow', 'xrayOptions', 'xrayNormalColor', 'xrayTime', 'cutPlane',
    'xrayShadowEnabled', 'xrayCascade0', 'xrayCascade1', 'xrayCascade2', 'xrayCascade3',
    'xrayViewFrustumZ', 'xrayFrustumLengths', 'xrayShadowsInfo', 'xrayCsmParams',
  ]);
  // Every `shaderUniforms.<name>` read in either stage is declared, and every custom
  // declaration is read: the WGSL and the structured contract cannot drift apart.
  const referenced = new Set<string>();
  for (const source of [LITE_XRAY_SHADER_PROGRAM.vertexSource, LITE_XRAY_SHADER_PROGRAM.fragmentSource]) {
    for (const match of source.matchAll(/shaderUniforms\.([A-Za-z_][A-Za-z0-9_]*)/g)) referenced.add(match[1]);
  }
  expect([...referenced].sort()).toEqual([...customUniforms].sort());
  expect(LITE_XRAY_SHADER_PROGRAM.attributes).toEqual(['position']);
  expect(LITE_XRAY_SHADER_PROGRAM.samplers).toEqual([
    { name: 'xrayDepth', sampleType: 'depth', viewDimension: '2d-array', comparison: true },
  ]);
  // Frozen palette / uniform values, xray-hologram.ts:114-116,154.
  expect(XRAY_TINT).toEqual([2 / 255, 132 / 255, 199 / 255, 26]);
  expect(XRAY_GLOW).toEqual([56 / 255, 189 / 255, 248 / 255, 1]);
  expect(XRAY_NORMAL_LINE_COLOR).toEqual([217 / 255, 119 / 255, 6 / 255, 0.75]);
  expect(XRAY_LINE_PARAMS).toEqual([1, 0.75, 0, 1.4]);
  expect(XRAY_ZERO_PARAMS).toEqual([0, 0, 0, 0]);
});

it('fails loudly when the structured X-Ray shader contract is malformed (compile/validation path)', () => {
  // Lite validates every declared uniform name against WGSL identifiers while the palette
  // material is built. There is no GPU in unit fixtures, so this synchronous validation is
  // the exact failure path the assembly takes before any pipeline can be compiled: a bad
  // contract must surface the native Lite error instead of creating a silently broken
  // hologram or being swallowed by the effect owner.
  const invalid = {
    ...LITE_XRAY_SHADER_PROGRAM,
    uniforms: [...LITE_XRAY_SHADER_PROGRAM.uniforms, { name: 'xray bad', type: 'vec4<f32>' as const }],
  };
  let error: unknown;
  try {
    createXrayEffect({ program: invalid });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(decodeError(error)).toContain('"xray bad" is not a valid WGSL identifier');
});

it('counts X-Ray targets per source role and shares palette materials across filter switches', () => {
  const h = harness();
  try {
    const equipment = Array.from({ length: 3 }, () => { const mesh = createBox(h.engine); mesh.material = createPbrMaterial(); return mesh; });
    const floor = createBox(h.engine); floor.material = createPbrMaterial();
    const subfabUpw = createBox(h.engine); subfabUpw.name = 'subfab-upw-main'; subfabUpw.material = createPbrMaterial();
    const subfabCda = createBox(h.engine); subfabCda.name = 'subfab-cda-main'; subfabCda.material = createPbrMaterial();
    const oht = createBox(h.engine); oht.name = 'native-oht-1'; oht.material = createPbrMaterial();
    const ohtShadow = createBox(h.engine); ohtShadow.name = 'native-oht-1-shadow'; ohtShadow.material = createPbrMaterial();
    const ohtShadowMaterial = ohtShadow.material;
    for (const mesh of [...equipment, floor, subfabUpw, subfabCda, oht, ohtShadow]) addToScene(h.scene, mesh);
    h.effects.configureXrayTargets([
      ...equipment.map(mesh => ({ mesh, role: 'equipment' as const })),
      { mesh: floor, role: 'floor' as const },
      { mesh: subfabUpw, role: 'subfab' as const },
      { mesh: subfabCda, role: 'subfab' as const },
      { mesh: oht, role: 'oht' as const },
      { mesh: ohtShadow, role: 'oht' as const },
    ]);
    expect(h.effects.targetCounts).toEqual({ equipment: 3, floor: 1, subfab: 2, oht: 2 });

    h.effects.setXrayFilter('upw');
    // One material instance per frozen surface state: the three equipment shells share it.
    expect(equipment[0].material).toBe(equipment[1].material);
    expect(equipment[1].material).toBe(equipment[2].material);
    // UPW systems highlight; the other subfab branch ghosts.
    expect(Array.from(getShaderUniform(subfabUpw.material as ShaderMaterial, 'xrayParams') as Float32Array))
      .toEqual([1, 1, 1, expect.closeTo(1.8)]);
    expect(Array.from(getShaderUniform(subfabCda.material as ShaderMaterial, 'xrayParams') as Float32Array))
      .toEqual([1, expect.closeTo(.15), 0, expect.closeTo(1.8)]);

    // 'all' collapses both subfab states onto the single highlighted material.
    h.effects.setXrayFilter('all');
    expect(subfabUpw.material).toBe(subfabCda.material);
    expect(Array.from(getShaderUniform(subfabCda.material as ShaderMaterial, 'xrayParams') as Float32Array))
      .toEqual([1, expect.closeTo(.55), 1, expect.closeTo(1.8)]);

    // The AMHS contact-shadow decal is counted as a target but excluded from the surface set.
    expect(ohtShadow.material).toBe(ohtShadowMaterial);

    h.effects.configureXrayTargets([]);
    expect(h.effects.targetCounts).toEqual({ equipment: 0, floor: 0, subfab: 0, oht: 0 });
  } finally { h.dispose(); }
});

it('re-binds the borrowed CSM receiver after a generator rebuild and detaches the old callback', () => {
  const h = harness();
  try {
    const receiverCallbacks = (generator: ReturnType<typeof createCsmDirectionalShadowGenerator>) =>
      (generator as unknown as { _onReceiverData?: ((data: Float32Array) => void)[] })._onReceiverData ?? [];
    const publish = (callbacks: readonly ((data: Float32Array) => void)[], data: Float32Array) => {
      for (const callback of [...callbacks]) callback(data);
    };
    const version = (material: ShaderMaterial) => (material as unknown as { _uniformVersion: number })._uniformVersion;
    const generator = (light: ReturnType<typeof createDirectionalLight>) =>
      createCsmDirectionalShadowGenerator(h.engine, light, { numCascades: 2, mapSize: 2048 });

    const lightA = createDirectionalLight([0, -1, 0]); addToScene(h.scene, lightA);
    const generatorA = generator(lightA);
    lightA.shadowGenerator = generatorA; h.scene.shadowGenerators.push(generatorA);
    const mesh = createBox(h.engine); mesh.material = createPbrMaterial(); addToScene(h.scene, mesh);
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]);
    h.effects.bindShadows(generatorA);
    h.effects.setXrayFilter('all');
    const palette = mesh.material as ShaderMaterial;
    // Borrowed texture is bound, but the retained receiver snapshot only exists after a publish.
    expect(h.effects.shadowLinked).toBe(false);
    expect(getShaderTexture(palette, 'xrayDepth')).toBe(getCsmReceiverTexture(generatorA));
    const callbacksA = receiverCallbacks(generatorA);
    expect(callbacksA).toHaveLength(1);
    publish(callbacksA, new Float32Array(80).fill(0.25));
    expect(h.effects.shadowLinked).toBe(true);
    expect(Array.from(getShaderUniform(palette, 'xrayCascade0') as Float32Array)).toEqual(new Array(16).fill(0.25));

    // Device recovery / shadow-owner rebuild publishes a replacement generator.
    const lightB = createDirectionalLight([0, -1, 0]); addToScene(h.scene, lightB);
    const generatorB = generator(lightB);
    lightB.shadowGenerator = generatorB; h.scene.shadowGenerators.push(generatorB);
    h.effects.bindShadows(generatorB);
    const callbacksB = receiverCallbacks(generatorB);
    expect(callbacksA).toHaveLength(0);
    expect(callbacksB).toHaveLength(1);
    // Re-binding resets the retained snapshot and swaps the borrowed texture before the next publish.
    expect(h.effects.shadowLinked).toBe(false);
    expect(getShaderTexture(palette, 'xrayDepth')).toBe(getCsmReceiverTexture(generatorB));
    expect(getShaderUniform(palette, 'xrayShadowEnabled')).toBe(0);
    const beforeB = version(palette);
    publish(callbacksA, new Float32Array(80).fill(0.125));
    expect(version(palette)).toBe(beforeB);
    publish(callbacksB, new Float32Array(80).fill(0.5));
    expect(h.effects.shadowLinked).toBe(true);
    expect(Array.from(getShaderUniform(palette, 'xrayCascade0') as Float32Array)).toEqual(new Array(16).fill(0.5));
  } finally { h.dispose(); }
});

it('disposes idempotently without releasing the borrowed CSM receiver or resurrecting callbacks', () => {
  const h = harness();
  try {
    const device = (h.engine as unknown as { _device: { createTexture: () => unknown } })._device;
    const textures: { destroyed: boolean }[] = [];
    device.createTexture = () => {
      const texture = { width: 2048, height: 2048, createView: () => ({}), destroyed: false,
        destroy() { texture.destroyed = true; } };
      textures.push(texture);
      return texture;
    };
    const light = createDirectionalLight([0, -1, 0]); addToScene(h.scene, light);
    const generator = createCsmDirectionalShadowGenerator(h.engine, light, { numCascades: 2, mapSize: 2048 });
    light.shadowGenerator = generator; h.scene.shadowGenerators.push(generator);
    const mesh = createBox(h.engine); mesh.material = createPbrMaterial(); addToScene(h.scene, mesh);
    mesh.metadata = { xrayCaster: false };
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]);
    h.effects.bindShadows(generator);
    h.effects.setXrayFilter('all');
    const palette = mesh.material as ShaderMaterial;
    const receiver = getCsmReceiverTexture(generator);
    const callbacks = (generator as unknown as { _onReceiverData?: unknown[] })._onReceiverData ?? [];
    expect(callbacks).toHaveLength(1);
    const marker = h.effects.meshes.find(candidate => candidate.name === 'wafer-follow-marker')!;
    const trail = h.effects.meshes.find(candidate => candidate.name === 'wafer-follow-trail')!;
    h.effects.setWaferPoint(3, 4, 5, true);
    const markerPosition = [marker.position.x, marker.position.y, marker.position.z];

    h.effects.dispose();
    h.effects.dispose();
    // The generator keeps ownership: the effects owner must never release the borrowed wrapper.
    expect(getCsmReceiverTexture(generator)).toBe(receiver);
    expect(textures.every(texture => !texture.destroyed)).toBe(true);
    expect(callbacks).toHaveLength(0);
    expect(mesh.material).not.toBe(palette);
    expect(mesh.metadata).toEqual({ xrayCaster: false });
    expect(h.effects.shadowLinked).toBe(false);

    // Every public mutator is a no-op after dispose (late GPU callbacks cannot touch the scene).
    h.effects.bindShadows(generator);
    expect(callbacks).toHaveLength(0);
    h.effects.configureXrayTargets([{ mesh, role: 'equipment' }]);
    h.effects.setXrayFilter('all');
    h.effects.setCutPlane(true, 'Z', 5, false);
    h.effects.setWaferPoint(9, 9, 9, true);
    h.effects.setWaferTrail([[0, 0, 0], [1, 1, 1]]);
    h.effects.update(16, 2000);
    expect(h.scene.clipPlane).toBeNull();
    expect([marker.position.x, marker.position.y, marker.position.z]).toEqual(markerPosition);
    expect(trail.visible).toBe(false);
    expect(mesh.material).not.toBe(palette);
    // A second dispose after the no-op calls is still safe.
    h.effects.dispose();
  } finally { h.dispose(); }
});
