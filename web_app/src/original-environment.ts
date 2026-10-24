import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { OriginalLegacyLightFalloff } from './original-lighting';

// Literal dimensions/loop order from createCleanroomEnvironment in the frozen
// original twin.html. The amber ceiling is independent of the optional FFU layer.
export const ORIGINAL_COLUMNS: [number, number, number][] = [];
for (let x = -40; x <= 45; x += 15) for (let z = -25; z <= 25; z += 16) ORIGINAL_COLUMNS.push([x, 5, z]);
export const ORIGINAL_AMBER_PANELS: [number, number, number][] = [];
for (let x = -34; x <= -19; x += 3.2) for (let z = -25; z <= 7; z += 3.2) ORIGINAL_AMBER_PANELS.push([x, 5.22, z]);
type Zone = { rect: readonly [number, number, number, number]; tone: 'amber' | 'white' | 'cold' };
export const ORIGINAL_ZONES: readonly Zone[] = [
  { rect: [-36, -27, 17, 36], tone: 'amber' }, { rect: [-12, -27, 17, 28], tone: 'cold' },
  { rect: [12, -27, 8, 28], tone: 'white' }, { rect: [20.8, -27, 8.2, 28], tone: 'cold' },
  { rect: [12, 3, 8, 28], tone: 'cold' }, { rect: [20.8, 3, 8.2, 28], tone: 'white' },
  { rect: [-12, 3, 17, 28], tone: 'white' }, { rect: [-36, 10, 17, 19], tone: 'cold' },
  { rect: [33, -27, 12, 58], tone: 'white' },
];

function material(scene: Scene, name: string, color: number, metallic = 0, roughness = 1, alpha = 1) {
  const result = new PBRMaterial(name, scene);
  result.albedoColor = Color3.FromInts(color >> 16 & 255, color >> 8 & 255, color & 255);
  result.metallic = metallic; result.roughness = roughness; result.alpha = alpha;
  result.directIntensity = Math.PI; result.environmentIntensity = 0;
  result.ambientColor = Color3.White(); result.maxSimultaneousLights = 8;
  if (alpha < 1) result.disableDepthWrite = true;
  new OriginalLegacyLightFalloff(result);
  return result;
}

/** Source canvas recipe: 512px tile, 32px perforation pitch, source repeat factors. */
function floorTexture(scene: Scene, amber: boolean) {
  const texture = new DynamicTexture(amber ? 'original-litho-floor' : 'original-access-floor', 512, scene, true);
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = amber ? '#f8fafc' : '#cbd5e1'; ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = amber ? '#f1f5f9' : '#e2e8f0'; ctx.fillRect(2, 2, 508, 508);
  ctx.fillStyle = amber ? '#ffffff' : '#d8e2ec'; ctx.fillRect(6, 6, 500, 500);
  ctx.fillStyle = '#64748b'; ctx.strokeStyle = amber ? 'rgba(245,158,11,0.4)' : 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
  for (let x = 24; x < 500; x += 32) for (let y = 24; y < 500; y += 32) {
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = amber ? '#cbd5e1' : '#94a3b8'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, 512, 512);
  texture.update(false); texture.wrapU = Texture.WRAP_ADDRESSMODE; texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = amber ? 28 : 95; texture.vScale = amber ? 60 : 70;
  texture.anisotropicFilteringLevel = 8;
  // The original r128 CanvasTexture retains its default LinearEncoding.
  texture.gammaSpace = false;
  return texture;
}

export function buildOriginalEnvironment(scene: Scene, shell: TransformNode) {
  const addBox = (name: string, size: readonly number[], at: readonly number[], mat: PBRMaterial) => {
    const mesh = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    mesh.position.set(at[0], at[1], at[2]); mesh.material = mat; mesh.parent = shell; mesh.isPickable = false;
    return mesh;
  };
  const floor = MeshBuilder.CreateGround('procedural-floor', { width: 114, height: 84 }, scene);
  const floorMat = material(scene, 'procedural-floor-material', 0xdce2ea, 0.16, 0.36);
  floorMat.albedoTexture = floorTexture(scene, false); floor.material = floorMat; floor.isPickable = false;
  addBox('procedural-slab', [114, 0.35, 84], [0, -0.2, 0], material(scene, 'original-concrete', 0x334155, 0.1, 0.85));
  const column = material(scene, 'original-column', 0x94a3b8, 0.35, 0.35);
  ORIGINAL_COLUMNS.forEach((at, i) => {
    const mesh = addBox(`procedural-column-${i}`, [0.7, 10, 0.7], at, column);
    mesh.metadata = { staticShadowCaster: false }; // Explicitly disabled in the original.
  });
  ORIGINAL_ZONES.forEach(({ rect: [x, z, w, d], tone }, i) => {
    const plane = MeshBuilder.CreateGround(`native-zone-${i}`, { width: w - 0.2, height: d - 0.2 }, scene);
    const mat = tone === 'amber' ? material(scene, `original-zone-${i}`, 0xffffff, 0.2, 0.22, 0.6)
      : tone === 'white' ? material(scene, `original-zone-${i}`, 0xf8fafc, 0.15, 0.35, 0.45)
        : material(scene, `original-zone-${i}`, 0x64748b, 0.18, 0.38, 0.32);
    if (tone === 'amber') mat.albedoTexture = floorTexture(scene, true);
    mat.zOffset = -2; plane.material = mat; plane.position.set(x + w / 2, 0.015, z + d / 2); plane.isPickable = false;
    const x0 = x + 0.1, x1 = x + w - 0.1, z0 = z + 0.1, z1 = z + d - 0.1;
    const border = MeshBuilder.CreateLines(`native-zone-border-${i}`, { points: [[x0,z0],[x1,z0],[x1,z1],[x0,z1],[x0,z0]].map(([px,pz]) => new Vector3(px, 0.02, pz)) }, scene);
    border.color = Color3.FromHexString('#94a3b8'); border.alpha = 0.65; border.isPickable = false;
    if (tone === 'amber') for (const pz of [z, z + d]) addBox(`original-hazard-${pz}`, [w, 0.04, 0.15], [x + w / 2, 0.02, pz], material(scene, `hazard-${pz}`, 0xeab308, 0, 0.4));
  });
  const aisle = MeshBuilder.CreateGround('native-zone-aisle', { width: 6, height: 68 }, scene);
  aisle.position.set(12, 0.01, 0); aisle.isPickable = false;
  aisle.material = material(scene, 'original-aisle', 0x475569, 0.2, 0.5, 0.22);
  const amberLight = material(scene, 'original-amber-strip', 0xfef08a, 0, 0.1);
  amberLight.emissiveColor = Color3.FromHexString('#f59e0b').scale(1.6);
  const amberTile = material(scene, 'original-amber-tile', 0xfbbf24, 0, 0.3);
  amberTile.emissiveColor = Color3.FromHexString('#d97706').scale(0.35);
  const trim = material(scene, 'original-amber-trim', 0xcfd8dc, 0.85);
  for (const x of [-33, -28.5, -24, -19.5]) {
    addBox(`original-amber-strip-${x}`, [0.22,0.06,34], [x,5.25,-9], amberLight);
    addBox(`original-amber-trim-${x}`, [0.32,0.04,34.2], [x,5.27,-9], trim);
  }
  ORIGINAL_AMBER_PANELS.forEach((at,i) => addBox(`original-amber-panel-${i}`, [2.4,0.05,2.4], at, amberTile));
  const railMat = material(scene, 'original-curtain-rail', 0xcbd5e1, 0.9, 0.18);
  addBox('original-curtain-rail-east', [0.18,0.14,28.2], [-16.5,5.2,-13], railMat);
  addBox('original-curtain-rail-south', [19.5,0.14,0.18], [-26.25,5.2,5], railMat);
  const curtain = material(scene, 'original-amber-curtain', 0xf59e0b, 0, 0.1, 0.68);
  curtain.subSurface.isRefractionEnabled = true; curtain.subSurface.refractionIntensity = 0.76;
  curtain.indexOfRefraction = 1.48;
  const strip = (name: string, x: number, z: number, east: boolean) => {
    const mesh = MeshBuilder.CreatePlane(name, { width: 0.36, height: 5.15 }, scene);
    mesh.position.set(x, 5.15 / 2, z); if (east) mesh.rotation.y = Math.PI / 2;
    mesh.material = curtain; mesh.parent = shell; mesh.isPickable = false;
  };
  for (let z = -26.8; z <= 0.8; z += 0.28) strip(`original-curtain-east-${z}`, -16.5 + (Math.round(z * 10) % 2 === 0 ? 0.015 : -0.015), z, true);
  for (let x = -35.8; x <= -16.8; x += 0.28) strip(`original-curtain-south-${x}`, x, 5 + (Math.round(x * 10) % 2 === 0 ? 0.015 : -0.015), false);
  const sign = addBox('original-amber-sign', [4.2,0.55,0.18], [-16.5,4.8,3], material(scene, 'original-sign', 0x1e293b, 0.5, 0.3));
  sign.rotation.y = Math.PI / 2;
  const signPlate = MeshBuilder.CreatePlane('original-amber-sign-plate', { width: 4.6, height: 0.45 }, scene);
  const signMat = material(scene, 'original-sign-light', 0xf59e0b, 0, 0.2); signMat.emissiveColor = Color3.FromHexString('#d97706').scale(0.9);
  signPlate.parent = sign; signPlate.position.z = 0.1; signPlate.material = signMat; signPlate.isPickable = false;
  return floor;
}
