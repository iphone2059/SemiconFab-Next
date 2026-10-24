import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

// Original twin.html buildSubfabUtilityPipeRack / buildSubfabUtilityDrops coordinates (metres).
const HEADERS = [
  { id: 'upw_supply', z: -4, radius: 0.16, color: '#0284c7' },
  { id: 'pcw_loop', z: -2.8, radius: 0.15, color: '#059669' },
  { id: 'vmb_gas', z: -1.6, radius: 0.13, color: '#7c3aed' },
  { id: 'chem_bulk', z: -0.4, radius: 0.14, color: '#d97706' },
] as const;
const DROPS = [
  { id: 'euv_1', x: -30, z: -22, pumpX: -22, pumpZ: -22, heated: false, gas: false },
  { id: 'euv_2', x: -30, z: -12, pumpX: -22, pumpZ: -12, heated: false, gas: false },
  { id: 'etch_ccp_1', x: -8, z: -24, pumpX: -5, pumpZ: -22, heated: true, gas: false },
  { id: 'etch_icp_1', x: 0, z: -24, pumpX: -5, pumpZ: -22, heated: true, gas: false },
  { id: 'cvd_1', x: 16, z: -10, pumpX: 20, pumpZ: -24, heated: true, gas: true },
] as const;

export function buildSubfabUtilities(scene: Scene, parent: TransformNode): void {
  const material = (name: string, color: string) => {
    const result = new StandardMaterial(`subfab-${name}-material`, scene);
    result.diffuseColor = Color3.FromHexString(color);
    result.specularColor = new Color3(0.45, 0.48, 0.5);
    result.specularPower = 64;
    return result;
  };
  const steel = material('stainless', '#d8e2ec');
  const support = material('support', '#334155');
  const heated = material('heated-foreline', '#d97706');
  const pump = material('pump', '#0369a1');
  const pcw = material('pcw', '#059669');
  const gas = material('gas', '#7c3aed');
  const safety = material('safety', '#eab308');
  const pipe = (name: string, path: Vector3[], radius: number, surface: StandardMaterial) => {
    const mesh = MeshBuilder.CreateTube(name, { path, radius, tessellation: 16, cap: 3 }, scene);
    mesh.material = surface; mesh.parent = parent; mesh.isPickable = false;
    return mesh;
  };
  const box = (name: string, width: number, height: number, depth: number, center: Vector3, surface: StandardMaterial) => {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
    mesh.position.copyFrom(center); mesh.material = surface; mesh.parent = parent; mesh.isPickable = false;
    return mesh;
  };
  for (const header of HEADERS) {
    const surface = material(header.id, header.color);
    const mesh = MeshBuilder.CreateCylinder(`subfab-header-${header.id}`, { height: 84, diameter: header.radius * 2, tessellation: 24 }, scene);
    mesh.position.set(0, -2.6, header.z); mesh.rotation.z = Math.PI / 2;
    mesh.material = surface; mesh.parent = parent; mesh.isPickable = false;
    mesh.metadata = { utility: header.id };
    for (let x = -36; x <= 36; x += 12) {
      pipe(`subfab-flange-${header.id}-${x}`, [new Vector3(x - 0.12, -2.6, header.z), new Vector3(x + 0.12, -2.6, header.z)], header.radius * 1.2, support);
    }
  }
  for (let x = -42; x <= 42; x += 6) {
    box(`subfab-rack-crossbar-${x}`, 0.16, 0.14, 5, new Vector3(x, -2.86, -2.2), support);
    for (const z of [-4.6, 0.2]) pipe(`subfab-hanger-${x}-${z}`, [new Vector3(x, -0.4, z), new Vector3(x, -2.8, z)], 0.025, steel);
  }
  const pumpStations = new Set<string>();
  for (const drop of DROPS) {
    const x = drop.x - 0.7, z = drop.z + 0.5;
    pipe(`subfab-foreline-${drop.id}`, [new Vector3(x, 0.1, z), new Vector3(x, -5.5, z),
      new Vector3(drop.pumpX, -5.5, z), new Vector3(drop.pumpX, -5.5, drop.pumpZ)], drop.heated ? 0.16 : 0.18, drop.heated ? heated : steel);
    for (const y of [0.025, -0.15]) pipe(`subfab-penetration-${drop.id}-${y}`,
      [new Vector3(x, y - 0.04, z), new Vector3(x, y + 0.04, z)], 0.5, support);
    for (let ring = 0; ring < 5; ring++) {
      const y = -1.4 + ring * 0.08;
      pipe(`subfab-bellows-${drop.id}-${ring}`, [new Vector3(x, y, z), new Vector3(x, y + 0.04, z)], 0.23, steel);
    }
    box(`subfab-valve-${drop.id}`, 0.48, 0.28, 0.36, new Vector3(x, -2.1, z), safety);
    for (const offset of [0, 0.28]) {
      const branchX = drop.x - 0.8 - offset;
      pipe(`subfab-pcw-${drop.id}-${offset}`, [new Vector3(branchX, 0.05, drop.z + 1.4),
        new Vector3(branchX, -2.6, drop.z + 1.4), new Vector3(branchX, -2.6, -2.8)], 0.075, pcw);
    }
    if (drop.gas) pipe(`subfab-gas-${drop.id}`, [new Vector3(drop.x + 0.9, -2.6, -1.6),
      new Vector3(drop.x + 0.9, -2.6, drop.z), new Vector3(drop.x + 0.9, 0.1, drop.z)], 0.055, gas);
    const station = `${drop.pumpX}:${drop.pumpZ}`;
    if (!pumpStations.has(station)) {
      pumpStations.add(station);
      box(`subfab-pump-skid-${drop.id}`, 2.4, 0.2, 1.4, new Vector3(drop.pumpX, -6.8, drop.pumpZ), support);
      box(`subfab-dry-pump-${drop.id}`, 1.6, 0.9, 0.9, new Vector3(drop.pumpX, -6.25, drop.pumpZ), pump);
      pipe(`subfab-booster-${drop.id}`, [new Vector3(drop.pumpX - 0.65, -5.65, drop.pumpZ),
        new Vector3(drop.pumpX + 0.65, -5.65, drop.pumpZ)], 0.3, steel);
    }
  }
  for (const walkway of [{ x: 0, z: 0, w: 2.2, d: 68 }, { x: -22, z: -8, w: 1.8, d: 36 },
    { x: 25, z: 4, w: 1.8, d: 40 }, { x: 0, z: -10, w: 52, d: 1.8 }]) {
    box(`subfab-walkway-${walkway.x}-${walkway.z}`, walkway.w, 0.012, walkway.d, new Vector3(walkway.x, -6.97, walkway.z), safety);
  }
}
