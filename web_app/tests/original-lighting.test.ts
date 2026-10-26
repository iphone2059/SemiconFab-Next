import { expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Scene } from '@babylonjs/core/scene';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { OriginalLegacyLightFalloff, OriginalPointLight, packOriginalLocalLights } from '../src/original-lighting';

it('keeps source point-light decay in the real light uniform buffer', () => {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'supportsUniformBuffers', { value: true });
  const scene = new Scene(engine);
  try {
    const light = new OriginalPointLight('highbay', Vector3.Zero(), scene, 1.2);
    light.range = 28;
    light.transferToEffect(null!, '0');
    const buffer = light._uniformBuffer;
    const index = (buffer as unknown as { _uniformLocations: Record<string, number> })._uniformLocations.vLightFalloff;
    expect(Array.from(buffer.getData()!.slice(index, index + 4))).toEqual([28, expect.closeTo(1 / 784, 6), expect.closeTo(1.2, 6), 0]);
  } finally { scene.dispose(); engine.dispose(); }
});

it('uses the frozen Lambert model and retains every source light beyond slot eight', () => {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'isWebGPU', { value: true });
  const scene = new Scene(engine);
  try {
    const material = new PBRMaterial('source', scene);
    material.maxSimultaneousLights = 8;
    new OriginalLegacyLightFalloff(material);
    expect(material.brdf.baseDiffuseModel).toBe(Constants.MATERIAL_DIFFUSE_MODEL_LAMBERT);
    expect(material.maxSimultaneousLights).toBe(2);
    for (let i = 0; i < 20; i++) {
      const light = new OriginalPointLight('source-' + i, new Vector3(i, 1, 0), scene, 1.5);
      light.range = 35;
    }
    const packed = packOriginalLocalLights(scene);
    expect(packed.count).toBe(20);
    expect(Array.from(packed.data.slice(19 * 16, 19 * 16 + 4))).toEqual([19, 1, 0, 35]);
  } finally { scene.dispose(); engine.dispose(); }
});
