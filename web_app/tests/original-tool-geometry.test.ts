import { expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import reference from './fixtures/original-tool-reference.json';
import { buildOriginalEquipment } from '../src/original-tool-geometry';
import { FAB_LAYOUT } from '../src/fab-layout';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';

// CPU geometry inspection only. Select the product's WGSL material language;
// NullEngine does not compile shaders or count as GPU acceptance.
function geometryEngine() {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'isWebGPU', { value: true });
  return engine;
}

it('uses the original legacy range falloff rather than inverse-square light falloff', () => {
  const engine = geometryEngine(); const scene = new Scene(engine);
  try {
    buildOriginalEquipment(scene, new TransformNode('equipment', scene));
    for (const material of scene.materials) if (material instanceof PBRMaterial) {
      expect(material.usePhysicalLightFalloff, material.name).toBe(false);
      expect(material.pluginManager?.getPlugin('OriginalLegacyLightFalloff')).toBeDefined();
    }
  } finally { scene.dispose(); engine.dispose(); }
});

it('matches all 121 original machine identities, positions, rotations and rendered bounds', () => {
  const engine = geometryEngine(); const scene = new Scene(engine);
  try {
    const root = new TransformNode('equipment', scene);
    const groups = buildOriginalEquipment(scene, root);
    expect(groups).toHaveLength(121);
    for (const original of reference.tools) {
      const index = original.layoutIndex;
      expect(FAB_LAYOUT[index].recordId).toBe(original.id);
      const group = groups[index];
      expect(group.position.asArray()).toEqual(original.position);
      expect(group.rotation.y).toBeCloseTo(original.rotation, 10);
      const bounds = group.getHierarchyBoundingVectors(true, mesh => original.family === 'catalog' || !mesh.name.startsWith('status-'));
      for (let axis = 0; axis < 3; axis++) {
        expect(bounds.min.asArray()[axis], `${original.id}:min:${axis}`).toBeCloseTo(original.min[axis], 5);
        expect(bounds.max.asArray()[axis], `${original.id}:max:${axis}`).toBeCloseTo(original.max[axis], 5);
      }
    }
  } finally { scene.dispose(); engine.dispose(); }
});

it('reproduces the original eight family vertex clouds and per-part colors, without invented attachments', () => {
  const engine = geometryEngine(); const scene = new Scene(engine);
  const key = (point: readonly number[]) => point.map(value => Math.round(value * 10000)).join(',');
  try {
    const groups = buildOriginalEquipment(scene, new TransformNode('equipment', scene));
    for (const family of reference.families) {
      const sample = reference.tools.find(tool => tool.family === family.family)!;
      const index = sample.layoutIndex;
      const group = groups[index];
      const expected = new Set(family.points.map((point, i) => key([...point, ...family.colors.slice(i * 3, i * 3 + 3)])));
      const actual = new Set<string>();
      for (const mesh of group.getChildMeshes().filter(mesh => !mesh.name.startsWith('status-'))) {
        const positions = mesh.getVerticesData('position')!;
        const material = mesh.material as unknown as { albedoColor: { asArray(): number[] } };
        const transform = mesh.computeWorldMatrix(true).multiply(group.computeWorldMatrix(true).clone().invert());
        for (let i = 0; i < positions.length; i += 3) {
          const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, i), transform);
          actual.add(key([...point.asArray(), ...material.albedoColor.asArray()]));
        }
      }
      expect([...actual].sort(), family.family).toEqual([...expected].sort());
    }
  } finally { scene.dispose(); engine.dispose(); }
});

it('matches every catalog part geometry, position, color, opacity, metallic and roughness', () => {
  const engine = geometryEngine(); const scene = new Scene(engine);
  const key = (point: readonly number[]) => point.map(value => Math.round(value * 10000)).join(',');
  try {
    const groups = buildOriginalEquipment(scene, new TransformNode('equipment', scene));
    for (const original of reference.catalog) {
      const group = groups[FAB_LAYOUT.findIndex(tool => tool.recordId === original.id)];
      const wire = original.parts.find(part => part.type === 'WireframeGeometry');
      if (wire) {
        const positions = group.getChildMeshes().find(mesh => mesh.name.endsWith('-wire'))!.getVerticesData('position')!;
        const edges: string[] = [];
        for (let i = 0; i < positions.length; i += 6) edges.push([key(Array.from(positions.slice(i, i+3))), key(Array.from(positions.slice(i+3, i+6)))].sort().join('|'));
        const expected: string[] = [];
        for (let i = 0; i < wire.points.length; i += 2) expected.push([key(wire.points[i]), key(wire.points[i+1])].sort().join('|'));
        expect(edges.sort()).toEqual(expected.sort());
      }
      for (const part of original.parts.filter(part => part.type !== 'WireframeGeometry')) {
        const mesh = group.getChildMeshes().find(mesh => mesh.position.asArray().every((value, axis) => Math.abs(value - part.position[axis]) < 1e-5))!;
        expect(mesh, `${original.id}:${part.type}:${part.position}`).toBeDefined();
        const positions = mesh.getVerticesData('position')!;
        const actual: number[][] = [];
        for (let i = 0; i < positions.length; i += 3) actual.push([positions[i], positions[i+1], positions[i+2]]);
        expect([...new Set(actual.map(key))].sort()).toEqual([...new Set(part.points.map(key))].sort());
        const material = mesh.material as unknown as { albedoColor: { asArray(): number[] }; alpha: number; metallic: number; roughness: number };
        // Beacon color is runtime SEMI state, independently supplied by the existing SSE feed.
        if (part.type !== 'CylinderGeometry') material.albedoColor.asArray().forEach((value, axis) => expect(value).toBeCloseTo(part.color[axis], 7));
        expect(material.alpha).toBe(part.alpha);
        expect(material.metallic).toBe(part.metallic);
        expect(material.roughness).toBe(part.roughness);
      }
    }
  } finally { scene.dispose(); engine.dispose(); }
});
