import { expect, it } from 'vitest';
import { createSceneContext, createPbrMaterial, createPointLight, createTransformNode, setParent,
  createStandardMaterial, type EngineContext } from '@babylonjs/lite';
import { createLiteLighting, packLiteLocalLights } from '../src/render/lite/lighting';
import { attachNextCoordinateFrame } from '../src/render/lite/next-coordinate-frame';

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
