import { Color3 } from '@babylonjs/core/Maths/math.color';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { ICanvasRenderingContext } from '@babylonjs/core/Engines/ICanvas';
import type { Scene } from '@babylonjs/core/scene';
import { OriginalLegacyLightFalloff } from './original-lighting';

// Read-only port of the frozen original page (SemiconFab/twin.html, lines
// 16007-16535): buildRoofHVACLayer, initRoofExhaustParticles,
// updateRoofHVACParticles, createRoofSprite, renderRoofSpriteCanvas and
// updateRoofHVACLanguage. Dimensions/positions are the literal metres from the
// source. r128 MeshStandardMaterial (color/roughness/metalness) is mapped to
// PBRMaterial with the project legacy light falloff used by the other
// original-* ports. No file of the original page is imported or modified.

export type RoofHvacLanguage = 'zh' | 'en';

export interface RoofHvacMau {
  readonly id: 'MAU-1' | 'MAU-2' | 'MAU-3';
  readonly x: number;
  readonly z: number;
  readonly nameEn: string;
  readonly nameZh: string;
}

export interface RoofHvacSupplyMain {
  readonly line: 'north' | 'central' | 'south';
  readonly z: number;
  readonly tooltipEn: string;
  readonly tooltipZh: string;
}

export interface RoofHvacBayDrop {
  readonly x: number;
  readonly z: number;
  readonly nameEn: string;
  readonly nameZh: string;
}

export interface RoofHvacChimney {
  readonly x: number;
  readonly z: number;
  readonly stack: string;
  readonly nameEn: string;
  readonly nameZh: string;
}

/** Original "roofHVACLayer" group name (source line 16019). */
export const ROOF_HVAC_GROUP_NAME = 'roofHVACLayer';

/** Source: BoxGeometry(85, 0.3, 60) at (4.5, 8.0, 1.0), #cfd4dc. */
export const ORIGINAL_ROOF_SLAB = {
  width: 85, height: 0.3, depth: 60, x: 4.5, y: 8, z: 1,
  color: 0xcfd4dc, roughness: 0.65, metalness: 0.2,
} as const;

/** Source: parNSGeo (85, 0.45, 0.3) at z = -29/31 and parEWGeo (0.3, 0.45, 60) at x = -38/47, #94a3b8. */
export const ORIGINAL_ROOF_PARAPETS = [
  { id: 'north', width: 85, height: 0.45, depth: 0.3, x: 4.5, y: 8.35, z: -29 },
  { id: 'south', width: 85, height: 0.45, depth: 0.3, x: 4.5, y: 8.35, z: 31 },
  { id: 'west', width: 0.3, height: 0.45, depth: 60, x: -38, y: 8.35, z: 1 },
  { id: 'east', width: 0.3, height: 0.45, depth: 60, x: 47, y: 8.35, z: 1 },
] as const;

/** Source: 3 make-up air units, 6 x 3 x 4 m bodies on 6.4 x 0.2 x 4.4 m curbs at z = -20. */
export const ORIGINAL_ROOF_MAUS: readonly RoofHvacMau[] = [
  { id: 'MAU-1', x: -20, z: -20, nameEn: 'MAU-1 Make-up Air Unit', nameZh: 'MAU-1 新风机组' },
  { id: 'MAU-2', x: 5, z: -20, nameEn: 'MAU-2 Make-up Air Unit', nameZh: 'MAU-2 新风机组' },
  { id: 'MAU-3', x: 30, z: -20, nameEn: 'MAU-3 Make-up Air Unit', nameZh: 'MAU-3 新风机组' },
] as const;

export const ORIGINAL_ROOF_MAU = {
  groupY: 9.65,
  body: { width: 6, height: 3, depth: 4 },
  louver: { width: 5.2, height: 2.2, z: 2.02 },
  fanCowl: { radius: 0.7, height: 0.5, tessellation: 16, localX: 1.6, localY: 1.75 },
  curb: { width: 6.4, height: 0.2, depth: 4.4, localY: -1.4 },
  sprite: { width: 4, height: 1, localY: 2.8 },
} as const;

/** Source: supply mains 81 x 0.8 x 1.2 m at (4.5, 8.65, z), blue #7db8e8. */
export const ORIGINAL_ROOF_SUPPLY_MAINS: readonly RoofHvacSupplyMain[] = [
  {
    line: 'north', z: -15,
    tooltipEn: 'Supply Air Main (North Line) → Lithography, Etch & Thin Film Bays',
    tooltipZh: '送风主管 (北干线) → 光刻/刻蚀/薄膜核心工艺区',
  },
  {
    line: 'central', z: 0,
    tooltipEn: 'Supply Air Main (Central Line) → Resist Track, Metrology & Inspection',
    tooltipZh: '送风主管 (中干线) → 涂胶显影、量测与缺陷检测区',
  },
  {
    line: 'south', z: 15,
    tooltipEn: 'Supply Air Main (South Line) → Diffusion, Wet Clean, CMP & Implant Bays',
    tooltipZh: '送风主管 (南干线) → 扩散炉管/湿法清洗/CMP/离子注入区',
  },
] as const;

/** Source: feeder ducts 0.9 x 0.7 x 35 m at (mau.x, 8.65, -2.5). */
export const ORIGINAL_ROOF_SUPPLY_FEEDER = {
  width: 0.9, height: 0.7, depth: 35, y: 8.65, z: -2.5,
} as const;

/** Source: 12 branch drop pipes 0.75 x 3.43 x 0.75 m from y = 8.65 down to y = 5.22. */
export const ORIGINAL_ROOF_BAY_DROPS: readonly RoofHvacBayDrop[] = [
  { x: -27.5, z: -15, nameEn: 'Lithography Scanner Bay', nameZh: '光刻曝光核心间 (黄光区)' },
  { x: -27.5, z: 0, nameEn: 'Resist Track & Coater/Dev Bay', nameZh: '涂胶显影跟踪机区 (黄光区)' },
  { x: -4.5, z: -15, nameEn: 'Plasma Dry Etch Bay', nameZh: '等离子干法刻蚀区' },
  { x: 20, z: -15, nameEn: 'Thin Film Deposition Bay (CVD/PVD)', nameZh: '薄膜沉积与外延区' },
  { x: 25.5, z: 15, nameEn: 'Thermal Diffusion & Oxidation Bay', nameZh: '高温氧化扩散炉管区' },
  { x: 15.5, z: 15, nameEn: 'Ion Implantation Bay', nameZh: '离子注入机区' },
  { x: -8.5, z: 15, nameEn: 'CMP Planarization Bay', nameZh: '化学机械研磨平坦化区' },
  { x: 0.5, z: 15, nameEn: 'Automated Wet Cleaning Bay', nameZh: '湿法清洗腐蚀工作台区' },
  { x: -27.5, z: 15, nameEn: 'In-line CD-SEM Metrology Bay', nameZh: '在线微观量测与椭偏仪区' },
  { x: -27.5, z: 25, nameEn: 'Darkfield Defect Inspection Bay', nameZh: '光学缺陷暗场检测区' },
  { x: 39, z: -15, nameEn: 'Advanced Packaging Bay', nameZh: '先进封装与异构集成区' },
  { x: 39, z: 8, nameEn: 'Wafer Sort & ATE Final Test Bay', nameZh: '晶圆探针测试与ATE分选区' },
] as const;

export const ORIGINAL_ROOF_SUPPLY_DROP = {
  width: 0.75, height: 3.43, depth: 0.75, y: 6.935,
} as const;

/** Source: 5 exhaust stacks (r = 0.5 m, h = 4 m, 20 sides) at z = 27, orange #e8935a. */
export const ORIGINAL_ROOF_CHIMNEYS: readonly RoofHvacChimney[] = [
  { x: -25, z: 27, stack: '#1', nameEn: 'Acid / Corrosive Wet Scrubber Stack', nameZh: '酸性腐蚀废气洗涤塔排气烟囱' },
  { x: -10, z: 27, stack: '#2', nameEn: 'Ammonia / Alkali Exhaust Stack', nameZh: '碱性含氨废气排气烟囱' },
  { x: 5, z: 27, stack: '#3', nameEn: 'VOC Thermal Oxidizer (RTO) Stack', nameZh: 'VOC 挥发性有机物热氧化排气烟囱' },
  { x: 20, z: 27, stack: '#4', nameEn: 'Pyrophoric / Silane Abatement Stack', nameZh: '硅烷与特种易燃毒性尾气燃烧筒' },
  { x: 35, z: 27, stack: '#5', nameEn: 'General Cleanroom Thermal Exhaust Stack', nameZh: '厂房综合工艺散热排气烟囱' },
] as const;

export const ORIGINAL_ROOF_EXHAUST = {
  stack: { radius: 0.5, height: 4, tessellation: 20, y: 10.15, z: 27 },
  cowl: { radiusTop: 0.65, radiusBottom: 0.5, height: 0.3, tessellation: 20, y: 12.2 },
  particlesPerStack: 14,
  particleSize: 0.22,
  particleColor: 0xfed7aa,
  particleOpacity: 0.45,
  spawnBaseY: 12.2,
  spawnJitterY: 2.0,
  recycleY: 14.5,
  recycleJitterY: 0.2,
  radiusJitter: 0.35,
  minSpeed: 0.015,
  speedJitter: 0.02,
} as const;

export const ROOF_EXHAUST_PARTICLES_PER_STACK = ORIGINAL_ROOF_EXHAUST.particlesPerStack;
export const ROOF_EXHAUST_PARTICLE_COUNT = ORIGINAL_ROOF_CHIMNEYS.length * ROOF_EXHAUST_PARTICLES_PER_STACK;

/** Source sprite canvas/scale: 384x96 px CanvasTexture on a 4.0 x 1.0 sprite. */
export const ROOF_SPRITE_CANVAS = { width: 384, height: 96 } as const;
export const ROOF_SPRITE_FONT_TITLE = 'bold 24px "JetBrains Mono", system-ui, sans-serif';
export const ROOF_SPRITE_FONT_BODY = 'bold 18px system-ui, -apple-system, sans-serif';

/** Babylon's canvas abstraction omits the roundRect/textAlign/textBaseline members the original recipe uses. */
export interface RoofSpriteRenderingContext extends ICanvasRenderingContext {
  roundRect?(x: number, y: number, width: number, height: number, radii: number): void;
  textAlign: string;
  textBaseline: string;
}

/** Literal renderRoofSpriteCanvas recipe (source lines 16439-16470). */
export function drawOriginalRoofSprite(
  ctx: RoofSpriteRenderingContext,
  nameEn: string,
  nameZh: string,
  language: RoofHvacLanguage,
): void {
  ctx.clearRect(0, 0, ROOF_SPRITE_CANVAS.width, ROOF_SPRITE_CANVAS.height);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(6, 6, 372, 84, 16);
    ctx.fill();
  } else {
    ctx.fillRect(6, 6, 372, 84);
  }
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
  ctx.lineWidth = 3;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(6, 6, 372, 84, 16);
    ctx.stroke();
  } else {
    ctx.strokeRect(6, 6, 372, 84);
  }
  ctx.fillStyle = '#38bdf8';
  ctx.font = ROOF_SPRITE_FONT_TITLE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(nameEn.split(' ')[0], 192, 34);
  ctx.fillStyle = '#ffffff';
  ctx.font = ROOF_SPRITE_FONT_BODY;
  ctx.fillText(language.startsWith('zh') ? nameZh : nameEn, 192, 64);
}

export interface OriginalRoofHvacController {
  /** Source roofGroup, named "roofHVACLayer"; hidden until setVisible(true). */
  readonly group: TransformNode;
  setVisible(visible: boolean): void;
  setLanguage(language: RoofHvacLanguage): void;
  update(timeMs: number): void;
}

interface RoofMauLabel {
  mesh: Mesh;
  texture: DynamicTexture | null;
  ctx: RoofSpriteRenderingContext | null;
  nameEn: string;
  nameZh: string;
}

interface RoofExhaustParticle {
  mesh: Mesh;
  speed: number;
}

const SOURCE_FRAME_MS = 1000 / 60;
const MAX_FRAMES_PER_UPDATE = 120;

export interface BuildOriginalRoofHvacOptions {
  /** Initial sprite language; the app TwinLocale defaults to 'zh'. */
  language?: RoofHvacLanguage;
}

export function buildOriginalRoofHvac(
  scene: Scene,
  parent: TransformNode,
  options: BuildOriginalRoofHvacOptions = {},
): OriginalRoofHvacController {
  let language: RoofHvacLanguage = options.language ?? 'zh';
  let visible = false;
  let lastTimeMs: number | null = null;
  let pendingMs = 0;

  const group = new TransformNode(ROOF_HVAC_GROUP_NAME, scene);
  group.parent = parent;
  // Source: roofGroup.visible = false until toggleRoofVisibility(true).
  group.setEnabled(false);

  // r128 MeshStandardMaterial -> PBRMaterial with the project legacy falloff.
  const shaded = (name: string, color: number, metalness: number, roughness: number): PBRMaterial => {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = Color3.FromInts(color >> 16 & 255, color >> 8 & 255, color & 255);
    material.metallic = metalness;
    material.roughness = roughness;
    material.directIntensity = Math.PI;
    material.environmentIntensity = 0;
    material.ambientColor = Color3.White();
    material.maxSimultaneousLights = 8;
    new OriginalLegacyLightFalloff(material);
    return material;
  };

  const addBox = (
    name: string,
    size: { width: number; height: number; depth: number },
    x: number,
    y: number,
    z: number,
    material: PBRMaterial,
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.parent = group;
    mesh.isPickable = false;
    return mesh;
  };

  const addDuctBox = (
    name: string,
    size: { width: number; height: number; depth: number },
    x: number,
    y: number,
    z: number,
    material: PBRMaterial,
    tooltipEn: string,
    tooltipZh: string,
  ): Mesh => {
    const mesh = addBox(name, size, x, y, z, material);
    // Source userData for the roofDuctMeshes hover list (lines 16128-16287).
    mesh.metadata = { isDuct: true, tooltipEn, tooltipZh };
    mesh.isPickable = true;
    return mesh;
  };

  // 1. Concrete roof slab and architectural parapet perimeter.
  const slabMaterial = shaded('original-roof-slab-material', ORIGINAL_ROOF_SLAB.color, ORIGINAL_ROOF_SLAB.metalness, ORIGINAL_ROOF_SLAB.roughness);
  const slab = addBox('original-roof-slab', ORIGINAL_ROOF_SLAB, ORIGINAL_ROOF_SLAB.x, ORIGINAL_ROOF_SLAB.y, ORIGINAL_ROOF_SLAB.z, slabMaterial);
  // Source: roofSlab.receiveShadow = true. This Babylon build has no
  // AbstractMesh.castShadow; the app native static-shadow path treats opaque
  // meshes as casters unless metadata.staticShadowCaster === false, and the
  // source only ever sets castShadow = true (MAU bodies, supply mains, stacks),
  // so no caster flags are needed here.
  slab.receiveShadows = true;

  const parapetMaterial = shaded('original-roof-parapet-material', 0x94a3b8, 0.2, 0.7);
  for (const parapet of ORIGINAL_ROOF_PARAPETS) {
    addBox('original-roof-parapet-' + parapet.id, parapet, parapet.x, parapet.y, parapet.z, parapetMaterial);
  }

  // 2. Three MAU enclosures, front louvers, two fan cowls, curbs and bilingual sprites.
  const mauEnclosureMaterial = shaded('original-roof-mau-enclosure-material', 0x94a3b8, 0.55, 0.35);
  const mauLouverMaterial = shaded('original-roof-mau-louver-material', 0x334155, 0.4, 0.7);
  const mauFanMaterial = shaded('original-roof-mau-fan-material', 0x475569, 0.6, 0.3);
  const labels: RoofMauLabel[] = [];

  const createMauLabel = (mauGroup: TransformNode, mau: RoofHvacMau): RoofMauLabel => {
    const name = 'original-roof-' + mau.id.toLowerCase() + '-label';
    const mesh = MeshBuilder.CreatePlane(name, { width: ORIGINAL_ROOF_MAU.sprite.width, height: ORIGINAL_ROOF_MAU.sprite.height }, scene);
    mesh.position.set(0, ORIGINAL_ROOF_MAU.sprite.localY, 0);
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.parent = mauGroup;
    mesh.isPickable = false;

    const material = new PBRMaterial(name + '-material', scene);
    material.unlit = true;
    material.backFaceCulling = false;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.useAlphaFromAlbedoTexture = true;
    // Dark pill is the visible fallback if a 2D canvas cannot be allocated.
    material.albedoColor = Color3.FromInts(15, 23, 42);

    let texture: DynamicTexture | null = null;
    let ctx: RoofSpriteRenderingContext | null = null;
    if (typeof document !== 'undefined') {
      try {
        texture = new DynamicTexture(name + '-texture', { width: ROOF_SPRITE_CANVAS.width, height: ROOF_SPRITE_CANVAS.height }, scene, true);
        ctx = texture.getContext() as RoofSpriteRenderingContext;
        if (!ctx || typeof ctx.fillText !== 'function') {
          texture.dispose();
          texture = null;
          ctx = null;
        } else {
          drawOriginalRoofSprite(ctx, mau.nameEn, mau.nameZh, language);
          texture.hasAlpha = true;
          texture.update();
          material.albedoTexture = texture;
          material.albedoColor = Color3.White();
        }
      } catch {
        texture?.dispose();
        texture = null;
        ctx = null;
      }
    }
    mesh.material = material;
    mesh.metadata = { labelEn: mau.nameEn, labelZh: mau.nameZh, language };
    return { mesh, texture, ctx, nameEn: mau.nameEn, nameZh: mau.nameZh };
  };

  for (const mau of ORIGINAL_ROOF_MAUS) {
    const mauId = mau.id.toLowerCase();
    const mauGroup = new TransformNode('original-roof-' + mauId, scene);
    mauGroup.position.set(mau.x, ORIGINAL_ROOF_MAU.groupY, mau.z);
    mauGroup.parent = group;

    const body = MeshBuilder.CreateBox('original-roof-' + mauId + '-body', ORIGINAL_ROOF_MAU.body, scene);
    body.receiveShadows = true;
    body.material = mauEnclosureMaterial;
    body.parent = mauGroup;
    body.isPickable = true;
    body.metadata = {
      isDuct: true,
      tooltipEn: mau.nameEn + ' → Cleanroom Make-up Air & Filtration',
      tooltipZh: mau.nameZh + ' → 洁净厂房新风预调理与高效过滤',
    };

    const louver = MeshBuilder.CreatePlane('original-roof-' + mauId + '-louver', { width: ORIGINAL_ROOF_MAU.louver.width, height: ORIGINAL_ROOF_MAU.louver.height }, scene);
    louver.position.set(0, 0, ORIGINAL_ROOF_MAU.louver.z);
    // THREE PlaneGeometry faces +Z; the Babylon plane faces -Z, so flip it onto
    // the same outward-facing intake face.
    louver.rotation.y = Math.PI;
    louver.material = mauLouverMaterial;
    louver.parent = mauGroup;
    louver.isPickable = false;

    for (const [index, localX] of [-ORIGINAL_ROOF_MAU.fanCowl.localX, ORIGINAL_ROOF_MAU.fanCowl.localX].entries()) {
      const cowl = MeshBuilder.CreateCylinder('original-roof-' + mauId + '-cowl-' + (index + 1), {
        height: ORIGINAL_ROOF_MAU.fanCowl.height,
        diameterTop: ORIGINAL_ROOF_MAU.fanCowl.radius * 2,
        diameterBottom: ORIGINAL_ROOF_MAU.fanCowl.radius * 2,
        tessellation: ORIGINAL_ROOF_MAU.fanCowl.tessellation,
      }, scene);
      cowl.position.set(localX, ORIGINAL_ROOF_MAU.fanCowl.localY, 0);
      cowl.material = mauFanMaterial;
      cowl.parent = mauGroup;
      cowl.isPickable = false;
    }

    addBox(
      'original-roof-' + mauId + '-curb',
      ORIGINAL_ROOF_MAU.curb,
      0,
      ORIGINAL_ROOF_MAU.curb.localY,
      0,
      parapetMaterial,
    ).parent = mauGroup;

    labels.push(createMauLabel(mauGroup, mau));
  }

  // 3. Main supply ducts, transverse MAU feeders and branch drop pipes.
  const supplyMaterial = shaded('original-roof-supply-duct-material', 0x7db8e8, 0.3, 0.35);
  const mainDuct = { width: 81, height: 0.8, depth: 1.2 };
  for (const main of ORIGINAL_ROOF_SUPPLY_MAINS) {
    addDuctBox('original-roof-supply-main-' + main.line, mainDuct, 4.5, 8.65, main.z, supplyMaterial, main.tooltipEn, main.tooltipZh);
  }
  for (const mau of ORIGINAL_ROOF_MAUS) {
    addDuctBox(
      'original-roof-supply-feeder-' + mau.id.toLowerCase(),
      ORIGINAL_ROOF_SUPPLY_FEEDER,
      mau.x,
      ORIGINAL_ROOF_SUPPLY_FEEDER.y,
      ORIGINAL_ROOF_SUPPLY_FEEDER.z,
      supplyMaterial,
      'Supply Distribution Header (' + mau.id + ') → Process Mains',
      '送风分配总管 (' + mau.id + ') → 各工艺分支主管',
    );
  }
  ORIGINAL_ROOF_BAY_DROPS.forEach((branch, index) => {
    addDuctBox(
      'original-roof-supply-drop-' + index,
      ORIGINAL_ROOF_SUPPLY_DROP,
      branch.x,
      ORIGINAL_ROOF_SUPPLY_DROP.y,
      branch.z,
      supplyMaterial,
      'Supply air branch → ' + branch.nameEn,
      '送风支管 → ' + branch.nameZh,
    );
  });

  // 4. Exhaust stacks and cowls.
  const exhaustMaterial = shaded('original-roof-exhaust-material', 0xe8935a, 0.3, 0.35);
  for (const chimney of ORIGINAL_ROOF_CHIMNEYS) {
    const stackIndex = chimney.stack.slice(1);
    const mesh = MeshBuilder.CreateCylinder('original-roof-exhaust-stack-' + stackIndex, {
      height: ORIGINAL_ROOF_EXHAUST.stack.height,
      diameterTop: ORIGINAL_ROOF_EXHAUST.stack.radius * 2,
      diameterBottom: ORIGINAL_ROOF_EXHAUST.stack.radius * 2,
      tessellation: ORIGINAL_ROOF_EXHAUST.stack.tessellation,
    }, scene);
    mesh.position.set(chimney.x, ORIGINAL_ROOF_EXHAUST.stack.y, chimney.z);
    mesh.material = exhaustMaterial;
    mesh.parent = group;
    mesh.isPickable = true;
    // Source shares one userData object between a stack and its cowl.
    mesh.metadata = {
      isDuct: true,
      tooltipEn: 'Exhaust Chimney (Stack ' + chimney.stack + ') → ' + chimney.nameEn,
      tooltipZh: '工艺排气烟囱 (' + chimney.stack + ') → ' + chimney.nameZh,
    };

    const cowl = MeshBuilder.CreateCylinder('original-roof-exhaust-cowl-' + stackIndex, {
      height: ORIGINAL_ROOF_EXHAUST.cowl.height,
      diameterTop: ORIGINAL_ROOF_EXHAUST.cowl.radiusTop * 2,
      diameterBottom: ORIGINAL_ROOF_EXHAUST.cowl.radiusBottom * 2,
      tessellation: ORIGINAL_ROOF_EXHAUST.cowl.tessellation,
    }, scene);
    cowl.position.set(chimney.x, ORIGINAL_ROOF_EXHAUST.cowl.y, chimney.z);
    cowl.material = exhaustMaterial;
    cowl.parent = group;
    cowl.isPickable = true;
    cowl.metadata = mesh.metadata;
  }

  // 5. Exhaust particle controller. THREE.Points(size=0.22, sizeAttenuation) is
  // ported as 70 world-space camera-facing quads: the production engine is
  // WebGPU, whose point-list fill is a fixed 1 px and cannot express the
  // original world-space point size.
  const particleMaterial = new PBRMaterial('original-roof-exhaust-particle-material', scene);
  particleMaterial.unlit = true;
  particleMaterial.albedoColor = Color3.FromInts(254, 215, 170);
  particleMaterial.alpha = ORIGINAL_ROOF_EXHAUST.particleOpacity;
  particleMaterial.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  particleMaterial.backFaceCulling = false;

  const particles: RoofExhaustParticle[] = [];
  for (const chimney of ORIGINAL_ROOF_CHIMNEYS) {
    for (let index = 0; index < ROOF_EXHAUST_PARTICLES_PER_STACK; index++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * ORIGINAL_ROOF_EXHAUST.radiusJitter;
      const spawnY = ORIGINAL_ROOF_EXHAUST.spawnBaseY + Math.random() * ORIGINAL_ROOF_EXHAUST.spawnJitterY;
      const mesh = MeshBuilder.CreatePlane('original-roof-exhaust-particle-' + particles.length, {
        width: ORIGINAL_ROOF_EXHAUST.particleSize,
        height: ORIGINAL_ROOF_EXHAUST.particleSize,
      }, scene);
      mesh.position.set(chimney.x + Math.cos(angle) * radius, spawnY, chimney.z + Math.sin(angle) * radius);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.material = particleMaterial;
      mesh.parent = group;
      mesh.isPickable = false;
      particles.push({
        mesh,
        speed: ORIGINAL_ROOF_EXHAUST.minSpeed + Math.random() * ORIGINAL_ROOF_EXHAUST.speedJitter,
      });
    }
  }

  const setVisible = (next: boolean): void => {
    visible = next;
    group.setEnabled(next);
    // Source only advances particles while shown; re-show starts a fresh clock.
    lastTimeMs = null;
    pendingMs = 0;
  };

  const setLanguage = (next: RoofHvacLanguage): void => {
    language = next;
    for (const label of labels) {
      (label.mesh.metadata as { language: RoofHvacLanguage }).language = next;
      if (label.ctx && label.texture) {
        drawOriginalRoofSprite(label.ctx, label.nameEn, label.nameZh, next);
        label.texture.update();
      }
    }
  };

  const update = (timeMs: number): void => {
    // Source lines 16405-16419: skip while the roof layer is hidden.
    if (!visible) {
      return;
    }
    if (lastTimeMs === null) {
      lastTimeMs = timeMs;
      return;
    }
    const deltaMs = timeMs - lastTimeMs;
    lastTimeMs = timeMs;
    if (!(deltaMs > 0)) {
      return;
    }
    pendingMs += deltaMs;
    let frames = Math.floor(pendingMs / SOURCE_FRAME_MS);
    if (frames <= 0) {
      return;
    }
    pendingMs -= frames * SOURCE_FRAME_MS;
    if (frames > MAX_FRAMES_PER_UPDATE) {
      // rAF pauses when the tab is hidden; do not replay a long stall.
      frames = MAX_FRAMES_PER_UPDATE;
    }
    for (let frame = 0; frame < frames; frame++) {
      for (const particle of particles) {
        const nextY = particle.mesh.position.y + particle.speed;
        particle.mesh.position.y = nextY > ORIGINAL_ROOF_EXHAUST.recycleY
          ? ORIGINAL_ROOF_EXHAUST.spawnBaseY + Math.random() * ORIGINAL_ROOF_EXHAUST.recycleJitterY
          : nextY;
      }
    }
  };

  return { group, setVisible, setLanguage, update };
}
