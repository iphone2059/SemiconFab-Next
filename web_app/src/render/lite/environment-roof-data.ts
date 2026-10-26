// Source roof data/drawing from frozen SemiconFab twin.html b3666132.
// PolyForm Noncommercial 1.0.0; see docs/migration/twin-parity/attribution.md.
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

/** Literal renderRoofSpriteCanvas recipe (source lines 16439-16470). */
export function drawOriginalRoofSprite(
  ctx: CanvasRenderingContext2D,
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

