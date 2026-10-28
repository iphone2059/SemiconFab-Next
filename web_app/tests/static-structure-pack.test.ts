import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { staticStructure } from '../src/generated/static-structure-packed';

interface CommittedGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  lines: boolean;
}
interface CommittedEntity {
  name: string;
  geometry: string;
  material: string;
}
interface CommittedStaticStructure {
  geometries: Record<string, CommittedGeometry>;
  materials: Record<string, unknown>;
  entities: CommittedEntity[];
  lights: unknown[];
}

// Read the committed asset from disk (not through a bundler JSON transform) so this is a real
// drift gate: regenerating the asset without running tools/pack_static_structure.mjs fails here.
const committed = JSON.parse(readFileSync(
  fileURLToPath(new URL('../assets/lite-static-structure.json', import.meta.url)), 'utf8',
)) as CommittedStaticStructure;

it('decodes every packed geometry to exactly the committed JSON vertex data', () => {
  expect(Object.keys(staticStructure.geometries).sort()).toEqual(Object.keys(committed.geometries).sort());
  for (const [id, source] of Object.entries(committed.geometries)) {
    const packed = staticStructure.geometries[id];
    expect(packed, id).toBeDefined();
    expect(packed.positions, id + ':positions buffer').toBeInstanceOf(Float32Array);
    expect(packed.normals, id + ':normals buffer').toBeInstanceOf(Float32Array);
    expect(packed.uvs, id + ':uvs buffer').toBeInstanceOf(Float32Array);
    expect(packed.indices, id + ':indices buffer').toBeInstanceOf(Uint32Array);
    expect(packed.lines, id + ':lines').toBe(source.lines);
    expect(Array.from(packed.positions), id + ':positions').toEqual(source.positions);
    expect(Array.from(packed.normals), id + ':normals').toEqual(source.normals);
    expect(Array.from(packed.uvs), id + ':uvs').toEqual(source.uvs);
    expect(Array.from(packed.indices), id + ':indices').toEqual(source.indices);
  }
});

it('decodes every material exactly', () => {
  expect(staticStructure.materials).toEqual(committed.materials);
});

it('decodes every entity exactly and resolves its geometry/material references', () => {
  expect(staticStructure.entities).toEqual(committed.entities);
  for (const entity of staticStructure.entities) {
    expect(staticStructure.geometries[entity.geometry], entity.name + ':geometry').toBeDefined();
    expect(staticStructure.materials[entity.material], entity.name + ':material').toBeDefined();
  }
});

it('decodes every light and keeps the frozen structure counts', () => {
  expect(staticStructure.lights).toEqual(committed.lights);
  expect(Object.keys(staticStructure.geometries)).toHaveLength(222);
  expect(Object.keys(staticStructure.materials)).toHaveLength(59);
  expect(staticStructure.entities).toHaveLength(1648);
  expect(staticStructure.lights).toHaveLength(10);
});
