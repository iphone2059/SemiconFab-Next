import { expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { buildSubfabUtilities } from '../src/subfab-utilities';

it('routes the four original 84m headers and connects five through-floor forelines to the B1 pump level', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('subfab', scene);
    buildSubfabUtilities(scene, root);
    for (const [id, z] of [['upw_supply', -4], ['pcw_loop', -2.8], ['vmb_gas', -1.6], ['chem_bulk', -0.4]] as const) {
      const mesh = scene.getMeshByName(`subfab-header-${id}`)!;
      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      expect(bounds.minimumWorld.x).toBeCloseTo(-42);
      expect(bounds.maximumWorld.x).toBeCloseTo(42);
      expect(mesh.getAbsolutePosition().z).toBeCloseTo(z);
    }
    for (const id of ['euv_1', 'euv_2', 'etch_ccp_1', 'etch_icp_1', 'cvd_1']) {
      const mesh = scene.getMeshByName(`subfab-foreline-${id}`)!;
      mesh.computeWorldMatrix(true);
      expect(mesh.getBoundingInfo().boundingBox.maximumWorld.y).toBeGreaterThanOrEqual(0);
      expect(mesh.getBoundingInfo().boundingBox.minimumWorld.y).toBeLessThanOrEqual(-5.5);
    }
    root.setEnabled(false);
    expect(scene.getMeshByName('subfab-header-upw_supply')!.isEnabled()).toBe(false);
  } finally { scene.dispose(); engine.dispose(); }
});
