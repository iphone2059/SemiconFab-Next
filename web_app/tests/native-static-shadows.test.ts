import { expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { collectShadowGeometry, createShadowMatrix, shadowGeometryKey } from '../src/native-static-shadows';

it('casts transformed geometry and excludes disabled or transparent meshes', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parent = new TransformNode('equipment', scene);
    parent.position.set(10, 3, -4);
    const box = MeshBuilder.CreateBox('caster', { size: 2 }, scene);
    box.parent = parent;
    const hidden = MeshBuilder.CreateBox('hidden', {}, scene);
    hidden.setEnabled(false);
    const glass = MeshBuilder.CreateBox('glass', {}, scene);
    glass.visibility = 0.3;
    const wire = MeshBuilder.CreateLines('non-casting-wire', { points: [Vector3.Zero(), Vector3.One(), new Vector3(1, 0, 0)] }, scene);
    const geometry = collectShadowGeometry([box, hidden, glass, wire]);
    expect(geometry.meshCount).toBe(1);
    expect(geometry.indices.length).toBe(36);
    const vertices = Array.from(geometry.positions);
    expect(Math.min(...vertices.filter((_, i) => i % 3 === 0))).toBe(9);
    expect(Math.max(...vertices.filter((_, i) => i % 3 === 1))).toBe(4);
    expect(Math.min(...vertices.filter((_, i) => i % 3 === 2))).toBe(-5);
    const before = shadowGeometryKey([box]);
    parent.position.y = 6;
    expect(shadowGeometryKey([box])).not.toBe(before);
    box.setEnabled(false);
    expect(collectShadowGeometry([box]).indices.length).toBe(0);
  } finally { scene.dispose(); engine.dispose(); }
});

it('projects the FAB into a fixed RH zero-to-one light volume independently of the camera', () => {
  const matrix = createShadowMatrix(new Vector3(0.35, -1, 0.4));
  for (const x of [-57, 57]) for (const z of [-42, 42]) for (const y of [-7.3, 12]) {
    const point = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
    expect(Math.abs(point.x)).toBeLessThan(1);
    expect(Math.abs(point.y)).toBeLessThan(1);
    expect(point.z).toBeGreaterThan(0);
    expect(point.z).toBeLessThan(1);
  }
});
