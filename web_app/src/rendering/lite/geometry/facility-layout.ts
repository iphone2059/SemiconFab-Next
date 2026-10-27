// Frozen typed source parameters and Canvas2D label recipe from original-facility-architecture.ts.
// Original renderer remains unchanged; no equipment JSON or runtime legacy import.
export type FacilityLanguage = 'zh' | 'en';

export interface OriginalAirShowerConfig {
  readonly id: 'main' | 'litho';
  readonly equipmentId: string;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly isAmber: boolean;
}

/** Source buildFacilityArchitecturalInterfaces lines 10476-10510. */
export const ORIGINAL_AIR_SHOWERS: readonly OriginalAirShowerConfig[] = [
  {
    id: 'main', equipmentId: 'fac.airshower.main.1', x: 12, z: 34,
    width: 2.8, height: 2.8, depth: 3.4, isAmber: false,
  },
  {
    id: 'litho', equipmentId: 'fac.airshower.litho.1', x: -16.5, z: 3,
    width: 2.4, height: 2.8, depth: 3.2, isAmber: true,
  },
] as const;

export const ORIGINAL_AIR_SHOWER = {
  wallThickness: 0.35,
  topHeight: 0.45,
  topOffset: 0.22,
  nozzle: { radiusTop: 0.045, radiusBottom: 0.055, height: 0.035, tessellation: 12, rows: 3, columns: 3 },
  doorThickness: 0.06,
  doorHeightInset: 0.45,
  doorWidthInset: 0.7,
  windowScale: 0.65,
  indicator: { height: 0.05, depth: 0.08, widthRatio: 0.75, yInset: 0.12 },
  hmi: { width: 0.35, height: 0.25, depth: 0.04, y: 1.5, xInset: 0.05, zInset: 0.03 },
  hmiScreen: { width: 0.3, height: 0.2, z: 0.025 },
  jet: { radius: 0.18, height: 1.2, tessellation: 8, x: 0.45, yOffset: 0.5 },
  innerLight: { yOffset: 0.4, intensity: 0.4, range: 4 },
  sprite: { width: 4.6, height: 1.72, yOffset: 1.2 },
  purgeCycleSeconds: 12,
  purgeBlowAfterSeconds: 7,
  frameSeconds: 0.016,
} as const;

export interface OriginalStickyMatConfig {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly length: number;
  readonly rotationY: number;
}

/** Source stickyMatConfigs lines 10513-10526 (all rotY 0). */
export const ORIGINAL_STICKY_MATS: readonly OriginalStickyMatConfig[] = [
  { x: 12, z: 36.5, width: 1.1, length: 1.6, rotationY: 0 },
  { x: 12, z: 31.5, width: 1.1, length: 1.6, rotationY: 0 },
  { x: -16.5, z: 5.4, width: 1.1, length: 1.6, rotationY: 0 },
  { x: -16.5, z: 0.6, width: 1.1, length: 1.6, rotationY: 0 },
  { x: 12, z: -12.5, width: 1.1, length: 1.6, rotationY: 0 },
  { x: -12, z: 17.5, width: 1.1, length: 1.6, rotationY: 0 },
] as const;

export const ORIGINAL_STICKY_MAT = {
  frameThickness: 0.012,
  frameBorder: 0.08,
  matOffset: 0.004,
  tab: { width: 0.12, length: 0.16, xInset: 0.08, zInset: 0.1, offset: 0.006 },
  mark: { width: 0.06, length: 0.02, offset: 0.007 },
} as const;

/** Source buildCeilingFFU lines 15649-15772. */
export const ORIGINAL_CEILING_FFU = {
  deck: { width: 92, depth: 68, x: 4, y: 8.15, z: 0 },
  unit: { width: 2.3, height: 0.08, depth: 1.15, y: 8.1, fromX: -38, toX: 42, stepX: 2.5, fromZ: -28, toZ: 28, stepZ: 1.35 },
  lightAislesX: [-32, -22, -12, -2, 8, 18, 28, 38],
  lithoAisleMaxX: -18,
  lightFixture: { width: 0.12, height: 0.08, depth: 62, y: 8.04 },
  lightLens: { width: 0.08, height: 0.03, depth: 62, y: 7.99 },
  truss: { width: 84, height: 0.22, depth: 0.28, x: 3, y: 7.45, fromZ: -26, toZ: 28, stepZ: 6 },
  brace: { width: 0.08, height: 0.08, depth: 1.8, y: 7.7, zOffset: 0.6, fromX: -30, toX: 36, stepX: 14, angle: Math.PI / 4 },
  dropRod: { radius: 0.035, height: 1.6, y: 6.7 },
  cableTray: { width: 0.55, height: 0.08, depth: 62, y: 7, aislesX: [-24, 0, 24] },
  cable: { radius: 0.05, depth: 62, y: 7.06, tessellation: 8 },
} as const;

function axisValues(from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(value);
  }
  return values;
}

/** Generated exactly like the source for-loops so tests can assert the grid. */
export const ORIGINAL_FFU_GRID = {
  x: axisValues(ORIGINAL_CEILING_FFU.unit.fromX, ORIGINAL_CEILING_FFU.unit.toX, ORIGINAL_CEILING_FFU.unit.stepX),
  z: axisValues(ORIGINAL_CEILING_FFU.unit.fromZ, ORIGINAL_CEILING_FFU.unit.toZ, ORIGINAL_CEILING_FFU.unit.stepZ),
  trussZ: axisValues(ORIGINAL_CEILING_FFU.truss.fromZ, ORIGINAL_CEILING_FFU.truss.toZ, ORIGINAL_CEILING_FFU.truss.stepZ),
  braceX: axisValues(ORIGINAL_CEILING_FFU.brace.fromX, ORIGINAL_CEILING_FFU.brace.toX, ORIGINAL_CEILING_FFU.brace.stepX),
} as const;

export const ORIGINAL_FACILITY_COUNTS = {
  ffuUnits: ORIGINAL_FFU_GRID.x.length * ORIGINAL_FFU_GRID.z.length,
  lightAisles: ORIGINAL_CEILING_FFU.lightAislesX.length,
  trusses: ORIGINAL_FFU_GRID.trussZ.length,
  braces: ORIGINAL_FFU_GRID.trussZ.length * ORIGINAL_FFU_GRID.braceX.length * 2,
  dropRods: ORIGINAL_FFU_GRID.trussZ.length * ORIGINAL_FFU_GRID.braceX.length,
  cableTrays: ORIGINAL_CEILING_FFU.cableTray.aislesX.length,
  airShowers: ORIGINAL_AIR_SHOWERS.length,
  stickyMats: ORIGINAL_STICKY_MATS.length,
} as const;

export const FACILITY_ARCHITECTURE_GROUP_NAME = 'facilityArchitecturalInterfaces';
export const AIR_SHOWER_CHAMBERS_GROUP_NAME = 'airShowerChambers';
export const STICKY_MATS_GROUP_NAME = 'stickyMats';
export const CEILING_FFU_GROUP_NAME = 'ceilingFFU';

const BILLBOARD_FONT = "bold 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const BILLBOARD_FONT_ZH_TITLE = "bold 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const BILLBOARD_FONT_EN_TITLE = "bold 23px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const BILLBOARD_FONT_ZH_SUB = "17px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const BILLBOARD_FONT_EN_SUB = "15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
export const AIR_SHOWER_SPRITE_CANVAS = { width: 512, height: 192 } as const;

/** Literal drawAirShowerBillboardCanvas recipe (source lines 9927-10002). The source resets canvas size per draw; the texture canvas is fixed here. */
export function drawOriginalAirShowerBillboard(
  ctx: CanvasRenderingContext2D,
  isAmber: boolean,
  language: FacilityLanguage,
): void {
  ctx.clearRect(0, 0, AIR_SHOWER_SPRITE_CANVAS.width, AIR_SHOWER_SPRITE_CANVAS.height);
  const isZh = language === 'zh';

  ctx.fillStyle = isAmber ? 'rgba(24, 16, 8, 0.94)' : 'rgba(15, 23, 42, 0.94)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 176, 20);
  ctx.fill();

  ctx.strokeStyle = isAmber ? '#f59e0b' : '#38bdf8';
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 176, 20);
  ctx.stroke();

  ctx.fillStyle = isAmber ? '#d97706' : '#0284c7';
  ctx.beginPath();
  ctx.roundRect(24, 22, 154, 34, 12);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = BILLBOARD_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isAmber ? '● UV-SAFE' : '● AIRLOCK', 101, 39);

  ctx.fillStyle = isAmber ? '#fbbf24' : '#34d399';
  ctx.font = BILLBOARD_FONT;
  ctx.textAlign = 'right';
  ctx.fillText('READY · 28 m/s', 480, 39);

  let title: string;
  let sub: string;
  if (isAmber) {
    title = isZh ? '黄光抗紫外风淋气闸' : 'LITHO AMBER AIRLOCK';
    sub = isZh ? '589nm 防紫外 · ISO-1 洁净气闸' : '589nm UV-Safe · Esco/Terra ISO-1';
  } else {
    title = isZh ? '主人员洁净风淋气闸' : 'MAIN AIR SHOWER TUNNEL';
    sub = isZh ? 'ISO Class 1 入口 · 28 m/s 高速吹淋' : 'ISO Class 1 Entry · 28 m/s Jets';
  }

  ctx.fillStyle = isAmber ? '#fef08a' : '#f0f9ff';
  ctx.font = isZh ? BILLBOARD_FONT_ZH_TITLE : BILLBOARD_FONT_EN_TITLE;
  ctx.textAlign = 'left';
  ctx.fillText(title, 26, 96);

  ctx.fillStyle = '#94a3b8';
  ctx.font = isZh ? BILLBOARD_FONT_ZH_SUB : BILLBOARD_FONT_EN_SUB;
  ctx.fillText(sub, 26, 140);
}

