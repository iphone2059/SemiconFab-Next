import { expect, it } from 'vitest';
import { createSceneContext, createPbrMaterial, createPointLight, createTransformNode, setParent,
  createStandardMaterial, type EngineContext } from '@babylonjs/lite';
import { createLiteLighting, packLiteLocalLights, packLiteLocalLightsInto } from '../src/rendering/lite/lighting';
import { attachNextCoordinateFrame } from '../src/rendering/lite/next-coordinate-frame';

it('uses the source key/fill/ambient and all five amber points plus the source spotlight', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, []);
  expect(lighting.key.direction).toMatchObject({ x: -35, y: -65, z: -45 });
  expect(lighting.key.intensity).toBe(1.15);
  expect(lighting.key.diffuse).toEqual([1, 251 / 255, 245 / 255]);
  expect(lighting.fill.direction).toMatchObject({ x: 40, y: -35, z: 30 });
  expect(lighting.fill.intensity).toBe(0.32);
  expect(lighting.ambient.intensity).toBe(0.48);
  expect(lighting.ambient.groundColor).toEqual(lighting.ambient.diffuseColor);
  expect(lighting.localLights).toHaveLength(6);
  expect(lighting.localLights[0].position).toMatchObject({ x: -27.5, z: -20 });
  expect(lighting.localLights[0].position.y).toBeCloseTo(5.2, 6);
  expect(lighting.localLights[0].intensity).toBe(2.6);
  expect(scene.fog).toMatchObject({ mode: 2, density: 0.0055, color: [0.945, 0.961, 0.976] });
  expect(scene.imageProcessing).toMatchObject({ exposure: 1, contrast: 1, toneMappingEnabled: false });
  lighting.dispose();
});

it('packs source local decay/cone data in reflected world space and follows moved B1 parents', () => {
  const basement = createPointLight([2, -6, 3], 0.7); basement.range = 18;
  basement.metadata = { legacyDecay: 1 }; basement.diffuse = [0.1, 0.2, 0.3];
  const root = createTransformNode('basement'); setParent(basement, root);
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, [basement]);
  attachNextCoordinateFrame([lighting.root, root]);
  const packed = packLiteLocalLights(lighting.localLights);
  expect(packed.count).toBe(7);
  expect(Array.from(packed.data.slice(6 * 16, 6 * 16 + 4))).toEqual([2, -6, -3, 18]);
  expect(packed.data[6 * 16 + 11]).toBe(1);
  expect(packed.data[5 * 16 + 14]).toBe(1);
  root.position.y = -18;
  expect(packLiteLocalLights(lighting.localLights).data[6 * 16 + 1]).toBe(-24);
  lighting.dispose();
});

it('adds source PBR ambient and local lights through the public plugin without a second native hemi contribution', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const material = createPbrMaterial({ baseColorFactor: [0.5, 0.6, 0.7, 1] });
  const lighting = createLiteLighting(scene, []);
  lighting.configureMaterials([{ id: 'tool', material }]);
  expect(lighting.ambient.excludedMeshIds?.has('tool')).toBe(true);
  for (const light of lighting.localLights) expect(light.excludedMeshIds?.has('tool')).toBe(true);
  const plugin = material.plugins![0];
  const fields = plugin.getUniforms!().ubo!;
  const offsets = new Map(fields.map((field, index) => [field.name, index === 0 ? 0 : index === 1 ? 16 : 32]));
  const data = new Float32Array(24 * 16 + 8);
  plugin.writeUbo!(data, offsets);
  expect(data[0]).toBeCloseTo(207 / 255 * 0.48);
  expect(data[4]).toBe(6);
  expect(Array.from(data.slice(8, 12))).toEqual([-27.5, 5.199999809265137, -20, 16]);
  lighting.setLocalLightsEnabled(false);
  plugin.writeUbo!(data, offsets); expect(data[4]).toBe(0);
  lighting.dispose();
});

it('switches the native Standard ambient and PBR ambient UBO together and restores both', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, []);
  const pbr = createPbrMaterial({ baseColorFactor: [0.5, 0.6, 0.7, 1] });
  lighting.configureMaterials([{ id: 'wall', material: createStandardMaterial() }, { id: 'tool', material: pbr }]);
  const plugin = pbr.plugins![0];
  const data = new Float32Array(24 * 16 + 8);
  const offsets = new Map([['fabAmbient', 0], ['fabLightInfo', 16], ['fabLocalLights', 32]]);
  lighting.setAmbientEnabled(false); plugin.writeUbo!(data, offsets);
  expect(lighting.ambient.intensity).toBe(0);
  expect(Array.from(data.slice(0, 3))).toEqual([0, 0, 0]);
  expect(lighting.ambient.excludedMeshIds?.has('wall')).toBe(false);
  lighting.setAmbientEnabled(true); plugin.writeUbo!(data, offsets);
  expect(lighting.ambient.intensity).toBe(0.48);
  expect(data[0]).toBeCloseTo(207 / 255 * 0.48);
  lighting.dispose();
});

it('packs into a caller-owned buffer with the same output as the allocating wrapper', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, []);
  const buffer = new Float32Array(24 * 16);
  const count = packLiteLocalLightsInto(lighting.localLights, buffer);
  const allocated = packLiteLocalLights(lighting.localLights);
  expect(count).toBe(allocated.count);
  expect(Array.from(buffer)).toEqual(Array.from(allocated.data));
  lighting.dispose();
});

it('packs a moved-parent basement light into a caller-owned buffer identically', () => {
  const basement = createPointLight([2, -6, 3], 0.7); basement.range = 18;
  basement.metadata = { legacyDecay: 1 }; basement.diffuse = [0.1, 0.2, 0.3];
  const root = createTransformNode('basement'); setParent(basement, root);
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, [basement]);
  attachNextCoordinateFrame([lighting.root, root]);
  root.position.y = -18;
  const buffer = new Float32Array(24 * 16);
  const count = packLiteLocalLightsInto(lighting.localLights, buffer);
  const allocated = packLiteLocalLights(lighting.localLights);
  expect(count).toBe(allocated.count);
  expect(buffer[6 * 16 + 1]).toBe(-24);
  expect(Array.from(buffer)).toEqual(Array.from(allocated.data));
  lighting.dispose();
});

it('repacks into the same caller-owned buffer with stable content', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const lighting = createLiteLighting(scene, []);
  const buffer = new Float32Array(24 * 16);
  const firstCount = packLiteLocalLightsInto(lighting.localLights, buffer);
  const first = Array.from(buffer);
  const secondCount = packLiteLocalLightsInto(lighting.localLights, buffer);
  expect(buffer).toBeInstanceOf(Float32Array);
  expect(buffer.length).toBe(24 * 16);
  expect(secondCount).toBe(firstCount);
  expect(Array.from(buffer)).toEqual(first);
  // Only the wrapper allocates a fresh buffer; the into-variant mutates the caller's packet.
  expect(packLiteLocalLights(lighting.localLights).data).not.toBe(packLiteLocalLights(lighting.localLights).data);
  lighting.dispose();
});

it('reuses the packed packet across frame and material writes and repacks after toggles', () => {
  const scene = createSceneContext({} as EngineContext, { defaultRenderTask: false });
  const material = createPbrMaterial({ baseColorFactor: [0.5, 0.6, 0.7, 1] });
  const lighting = createLiteLighting(scene, []);
  lighting.configureMaterials([{ id: 'batched', material }]);
  try {
    const plugin = material.plugins![0];
    const offsets = new Map([['fabAmbient', 0], ['fabLightInfo', 16], ['fabLocalLights', 32]]);
    const data = new Float32Array(24 * 16 + 8);
    const frame = () => {
      for (const callback of (scene as unknown as { _beforeRender: (() => void)[] })._beforeRender) callback();
    };
    frame();
    plugin.writeUbo!(data, offsets);
    const first = Array.from(data);
    expect(first[0]).toBeCloseTo(207 / 255 * 0.48);
    expect(first[1]).toBeCloseTo(216 / 255 * 0.48);
    expect(first[2]).toBeCloseTo(220 / 255 * 0.48);
    expect(first[3]).toBe(0);
    expect(first[4]).toBe(6);
    // Repeated frames and per-material UBO writes must leave the exact same bytes in place.
    for (let repeat = 0; repeat < 2; repeat++) {
      frame();
      for (let materialWrite = 0; materialWrite < 3; materialWrite++) {
        plugin.writeUbo!(data, offsets);
        expect(Array.from(data)).toEqual(first);
      }
    }
    // Toggling locals invalidates the packet: even without an intervening frame the next UBO
    // write repacks the restored lights and reproduces the first-frame bytes exactly.
    lighting.setLocalLightsEnabled(false);
    frame(); plugin.writeUbo!(data, offsets);
    expect(data[4]).toBe(0);
    lighting.setLocalLightsEnabled(true);
    plugin.writeUbo!(data, offsets);
    expect(Array.from(data)).toEqual(first);
    // Ambient toggle rewrites only the ambient vec4; the packed light block stays byte-identical.
    lighting.setAmbientEnabled(false);
    plugin.writeUbo!(data, offsets);
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(data.slice(4))).toEqual(first.slice(4));
    lighting.setAmbientEnabled(true);
    plugin.writeUbo!(data, offsets);
    expect(Array.from(data)).toEqual(first);
  } finally { lighting.dispose(); }
});

it('keeps the source local-light capacity overflow contract', () => {
  const lights = Array.from({ length: 24 }, (_, index) => createPointLight([index, 0, 0], 1));
  expect(packLiteLocalLightsInto(lights, new Float32Array(24 * 16))).toBe(24);
  const overflow = [...lights, createPointLight([0, 0, 0], 1)];
  expect(() => packLiteLocalLightsInto(overflow, new Float32Array(24 * 16))).toThrow('Source local-light capacity exceeded');
  expect(() => packLiteLocalLights(overflow)).toThrow('Source local-light capacity exceeded');
});
