import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { ICanvasRenderingContext } from '@babylonjs/core/Engines/ICanvas';
import type { Scene } from '@babylonjs/core/scene';
import { OriginalLegacyLightFalloff, OriginalPointLight } from './original-lighting';
import type { AirShowerFrame } from './personnel-timeline';

// Read-only port of the frozen original page (SemiconFab/twin.html):
//   * buildFacilityArchitecturalInterfaces (lines 10475-10543): the two air
//     shower airlocks and the six tacky mats.
//   * createAirShower (10087-10249), createAirShowerSprite (10004-10024),
//     drawAirShowerBillboardCanvas (9927-10002), createStickyMat (10251-10317).
//   * air shower purge-cycle animation (19128-19197).
//   * buildCeilingFFU (15646-16005): ceiling deck, FFU unit grid, linear LED
//     aisles, yellow safety trusses/seismic braces and cable trays.
// Source dimensions/positions/materials are kept verbatim; THREE
// MeshStandardMaterial maps to PBRMaterial with the project legacy light
// falloff. No file of the original page is imported or modified.

export type FacilityLanguage = 'zh' | 'en';

/** Babylon's canvas abstraction omits members used by the source billboard recipe. */
export interface FacilityCanvasContext extends ICanvasRenderingContext {
  roundRect(x: number, y: number, width: number, height: number, radii: number): void;
  textAlign: string;
  textBaseline: string;
}

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
  ctx: FacilityCanvasContext,
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

export interface OriginalFacilityArchitectureController {
  /** Root "facilityArchitecturalInterfaces" group (airlocks and tacky mats). */
  readonly group: TransformNode;
  /** Independent ceiling group; source showCeiling starts false. */
  readonly ceilingGroup: TransformNode;
  /** The two air shower chamber groups, in source build order. */
  readonly airShowers: readonly TransformNode[];
  setVisible(visible: boolean): void;
  setCeilingVisible(visible: boolean): void;
  setLanguage(language: FacilityLanguage): void;
  update(timeMs: number): void;
  applyAirShowerFrames(frames: readonly AirShowerFrame[]): void;
}

export interface BuildOriginalFacilityArchitectureOptions {
  /** Initial billboard language; the app TwinLocale defaults to 'zh'. */
  language?: FacilityLanguage;
}

interface AirShowerBillboard {
  mesh: Mesh;
  texture: DynamicTexture | null;
  ctx: FacilityCanvasContext | null;
  isAmber: boolean;
  language: FacilityLanguage;
}

interface AirShowerController {
  config: OriginalAirShowerConfig;
  group: TransformNode;
  indicators: PBRMaterial[];
  jets: Array<{ mesh: Mesh; material: PBRMaterial }>;
  innerLight: PointLight;
  billboard: AirShowerBillboard;
  timer: number;
}

const MAX_FRAMES_PER_UPDATE = 120;
const SOURCE_FRAME_MS = 1000 / 60;

function rgba(color: number): Color3 {
  return Color3.FromInts(color >> 16 & 255, color >> 8 & 255, color & 255);
}

function materialColor(material: PBRMaterial, color: number): void {
  material.albedoColor = rgba(color);
  material.emissiveColor = rgba(color);
}

function buildOriginalFacilityArchitectureInternal(
  scene: Scene,
  parent: TransformNode,
  options: BuildOriginalFacilityArchitectureOptions,
): OriginalFacilityArchitectureController {
  let language: FacilityLanguage = options.language ?? 'zh';

  const group = new TransformNode(FACILITY_ARCHITECTURE_GROUP_NAME, scene);
  group.parent = parent;
  // Source buildFacilityArchitecturalInterfaces adds airlocks/mats directly to
  // the always-visible scene; only the ceiling is gated by showCeiling=false.
  const airShowersGroup = new TransformNode(AIR_SHOWER_CHAMBERS_GROUP_NAME, scene);
  airShowersGroup.parent = group;
  const stickyMatsGroup = new TransformNode(STICKY_MATS_GROUP_NAME, scene);
  stickyMatsGroup.parent = group;
  const ceilingGroup = new TransformNode(CEILING_FFU_GROUP_NAME, scene);
  ceilingGroup.parent = group;
  ceilingGroup.setEnabled(false);

  // r128 MeshStandardMaterial -> PBRMaterial with the shared legacy falloff.
  const shaded = (name: string, color: number, metalness = 0, roughness = 1): PBRMaterial => {
    const material = new PBRMaterial(name, scene);
    material.albedoColor = rgba(color);
    material.metallic = metalness;
    material.roughness = roughness;
    material.directIntensity = Math.PI;
    material.environmentIntensity = 0;
    material.ambientColor = Color3.White();
    material.maxSimultaneousLights = 8;
    new OriginalLegacyLightFalloff(material);
    return material;
  };
  const emissive = (material: PBRMaterial, color: number, intensity: number): PBRMaterial => {
    material.emissiveColor = rgba(color);
    material.emissiveIntensity = intensity;
    return material;
  };
  const unlit = (name: string, color: number, alpha = 1): PBRMaterial => {
    const material = new PBRMaterial(name, scene);
    material.unlit = true;
    material.albedoColor = rgba(color);
    material.alpha = alpha;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.backFaceCulling = false;
    return material;
  };

  const noShadowCaster = { staticShadowCaster: false } as const;
  const box = (
    name: string,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material: PBRMaterial,
    target: TransformNode,
    pickable = false,
    metadata?: Record<string, unknown>,
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.material = material;
    mesh.parent = target;
    mesh.isPickable = pickable;
    mesh.metadata = { ...noShadowCaster, ...metadata };
    return mesh;
  };
  const cylinder = (
    name: string,
    diameterTop: number,
    diameterBottom: number,
    height: number,
    tessellation: number,
    at: readonly [number, number, number],
    material: PBRMaterial,
    target: TransformNode,
    metadata?: Record<string, unknown>,
  ): Mesh => {
    const mesh = MeshBuilder.CreateCylinder(name, { diameterTop, diameterBottom, height, tessellation }, scene);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.material = material;
    mesh.parent = target;
    mesh.isPickable = false;
    mesh.metadata = { ...noShadowCaster, ...metadata };
    return mesh;
  };
  const plane = (
    name: string,
    size: readonly [number, number],
    at: readonly [number, number, number],
    material: PBRMaterial,
    target: TransformNode,
    rotation?: { x?: number; y?: number },
  ): Mesh => {
    const mesh = MeshBuilder.CreatePlane(name, { width: size[0], height: size[1] }, scene);
    mesh.position.set(at[0], at[1], at[2]);
    if (rotation?.x !== undefined) {
      mesh.rotation.x = rotation.x;
    }
    if (rotation?.y !== undefined) {
      mesh.rotation.y = rotation.y;
    }
    mesh.material = material;
    mesh.parent = target;
    mesh.isPickable = false;
    mesh.metadata = { ...noShadowCaster };
    return mesh;
  };

  const createBillboard = (chamberName: string, config: OriginalAirShowerConfig, target: TransformNode): AirShowerBillboard => {
    const name = chamberName + '-billboard';
    const mesh = MeshBuilder.CreatePlane(name, { width: ORIGINAL_AIR_SHOWER.sprite.width, height: ORIGINAL_AIR_SHOWER.sprite.height }, scene);
    mesh.position.set(0, config.height + ORIGINAL_AIR_SHOWER.sprite.yOffset, 0);
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.parent = target;
    mesh.isPickable = false;
    mesh.metadata = { ...noShadowCaster, labelKind: 'airshower-billboard', isAmber: config.isAmber, language };

    const material = new PBRMaterial(name + '-material', scene);
    material.unlit = true;
    material.backFaceCulling = false;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.useAlphaFromAlbedoTexture = true;
    // THREE SpriteMaterial had depthTest:false / depthWrite:false.
    material.depthFunction = Constants.ALWAYS;
    material.disableDepthWrite = true;
    material.albedoColor = Color3.FromInts(15, 23, 42);

    let texture: DynamicTexture | null = null;
    let ctx: FacilityCanvasContext | null = null;
    if (typeof document !== 'undefined') {
      try {
        texture = new DynamicTexture(name + '-texture', { width: AIR_SHOWER_SPRITE_CANVAS.width, height: AIR_SHOWER_SPRITE_CANVAS.height }, scene, true);
        ctx = texture.getContext() as FacilityCanvasContext;
        if (!ctx || typeof ctx.fillText !== 'function') {
          texture.dispose();
          texture = null;
          ctx = null;
        } else {
          drawOriginalAirShowerBillboard(ctx, config.isAmber, language);
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
    return { mesh, texture, ctx, isAmber: config.isAmber, language };
  };

  const buildAirShower = (config: OriginalAirShowerConfig): AirShowerController => {
    const chamberName = 'original-airshower-' + config.id;
    const chamber = new TransformNode(chamberName, scene);
    chamber.position.set(config.x, 0, config.z);
    chamber.parent = airShowersGroup;
    chamber.metadata = {
      equipmentId: config.equipmentId,
      isAirShower: true,
      isAmber: config.isAmber,
      width: config.width,
      height: config.height,
      depth: config.depth,
    };
    const partMetadata = { equipmentId: config.equipmentId, isAirShower: true, isAirShowerPart: true };
    const { width, height, depth } = config;
    const wallThickness = ORIGINAL_AIR_SHOWER.wallThickness;
    const halfWidth = width / 2;
    const halfDepth = depth / 2;

    const stainless = shaded(chamberName + '-stainless-material', 0xd8e0e9, 0.9, 0.22);
    const darkTrim = shaded(chamberName + '-dark-trim-material', 0x1e293b, 0, 0.5);
    const glass = shaded(chamberName + '-glass-material', config.isAmber ? 0xf59e0b : 0x38bdf8, 0, 0.1);
    glass.alpha = config.isAmber ? 0.55 : 0.35;
    glass.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    glass.subSurface.isRefractionEnabled = true;
    glass.subSurface.refractionIntensity = 0.8;
    glass.indexOfRefraction = 1.5;
    const nozzleMaterial = shaded(chamberName + '-nozzle-material', 0x94a3b8, 0.95, 0.1);

    // 1. Twin stainless air plenum walls.
    box(chamberName + '-plenum-left', [wallThickness, height, depth], [-halfWidth + wallThickness / 2, height / 2, 0], stainless, chamber, true, partMetadata);
    box(chamberName + '-plenum-right', [wallThickness, height, depth], [halfWidth - wallThickness / 2, height / 2, 0], stainless, chamber, true, partMetadata);

    // 2. Top centrifugal fan plenum (source y = height - 0.22).
    box(chamberName + '-top-plenum', [width, ORIGINAL_AIR_SHOWER.topHeight, depth], [0, height - ORIGINAL_AIR_SHOWER.topOffset, 0], stainless, chamber, true, partMetadata);

    // 3. High-velocity jet nozzle matrix (3 x 3 per side wall).
    const nozzle = ORIGINAL_AIR_SHOWER.nozzle;
    for (const [sideIndex, wallX] of [-halfWidth + wallThickness, halfWidth - wallThickness].entries()) {
      const rotationZ = sideIndex === 0 ? -Math.PI / 2 : Math.PI / 2;
      for (let row = 0; row < nozzle.rows; row++) {
        for (let column = 0; column < nozzle.columns; column++) {
          const nozzleMesh = cylinder(
            chamberName + '-nozzle-' + sideIndex + '-' + row + '-' + column,
            nozzle.radiusTop * 2, nozzle.radiusBottom * 2, nozzle.height, nozzle.tessellation,
            [wallX, 0.85 + row * 0.55, -depth * 0.35 + column * (depth * 0.35)],
            nozzleMaterial, chamber, partMetadata,
          );
          nozzleMesh.rotation.z = rotationZ;
        }
      }
    }

    // 4. Front/rear interlock doors with glass vision panels and indicator strips.
    const indicators: PBRMaterial[] = [];
    const doorWidth = width - ORIGINAL_AIR_SHOWER.doorWidthInset;
    const doorHeight = height - ORIGINAL_AIR_SHOWER.doorHeightInset;
    for (const [doorIndex, zPosition] of [-halfDepth, halfDepth].entries()) {
      const doorFrame = box(
        chamberName + '-door-' + doorIndex,
        [doorWidth, doorHeight, ORIGINAL_AIR_SHOWER.doorThickness],
        [0, doorHeight / 2, zPosition], darkTrim, chamber, true, partMetadata,
      );
      box(
        chamberName + '-door-' + doorIndex + '-window',
        [doorWidth * ORIGINAL_AIR_SHOWER.windowScale, doorHeight * ORIGINAL_AIR_SHOWER.windowScale, ORIGINAL_AIR_SHOWER.doorThickness * 1.2],
        [0, 0, 0], glass, doorFrame, true, partMetadata,
      );
      const indicatorMaterial = emissive(shaded(chamberName + '-indicator-' + doorIndex + '-material', 0x10b981, 0, 0.2), 0x10b981, 0.8);
      indicators.push(indicatorMaterial);
      box(
        chamberName + '-indicator-' + doorIndex,
        [doorWidth * ORIGINAL_AIR_SHOWER.indicator.widthRatio, ORIGINAL_AIR_SHOWER.indicator.height, ORIGINAL_AIR_SHOWER.indicator.depth],
        [0, doorHeight + ORIGINAL_AIR_SHOWER.indicator.yInset, zPosition], indicatorMaterial, chamber, true, partMetadata,
      );
    }

    // 5. Door-head touch HMI panel with air-speed readout.
    const hmi = ORIGINAL_AIR_SHOWER.hmi;
    const hmiMesh = box(
      chamberName + '-hmi', [hmi.width, hmi.height, hmi.depth],
      [halfWidth - hmi.xInset, hmi.y, halfDepth + hmi.zInset], darkTrim, chamber, true, partMetadata,
    );
    const screenMaterial = emissive(shaded(chamberName + '-hmi-screen-material', 0x0284c7, 0, 1), 0x0284c7, 0.9);
    const screen = plane(
      chamberName + '-hmi-screen', [ORIGINAL_AIR_SHOWER.hmiScreen.width, ORIGINAL_AIR_SHOWER.hmiScreen.height],
      [0, 0, ORIGINAL_AIR_SHOWER.hmiScreen.z], screenMaterial, hmiMesh, { y: Math.PI },
    );
    screen.metadata = { ...noShadowCaster, ...partMetadata };

    // 6. Additive air-jet cone streams (opacity 0 until a purge cycle).
    const jets: Array<{ mesh: Mesh; material: PBRMaterial }> = [];
    const jetConfig = ORIGINAL_AIR_SHOWER.jet;
    for (let index = 0; index < 4; index++) {
      const jetMaterial = unlit(chamberName + '-jet-' + index + '-material', config.isAmber ? 0xfef08a : 0xbae6fd, 0);
      jetMaterial.alphaMode = Constants.ALPHA_ADD;
      const jet = MeshBuilder.CreateCylinder(chamberName + '-jet-' + index, {
        diameterTop: 0, diameterBottom: jetConfig.radius * 2, height: jetConfig.height, tessellation: jetConfig.tessellation, cap: Mesh.NO_CAP,
      }, scene);
      jet.position.set(
        index % 2 === 0 ? -jetConfig.x : jetConfig.x,
        height - jetConfig.yOffset,
        -depth * 0.25 + Math.floor(index / 2) * depth * 0.5,
      );
      // Source coneGeo.rotateX(Math.PI): apex points down after the flip.
      jet.rotation.x = Math.PI;
      jet.material = jetMaterial;
      jet.parent = chamber;
      jet.isPickable = false;
      jet.metadata = { ...noShadowCaster };
      jets.push({ mesh: jet, material: jetMaterial });
    }

    // 7. Interior cleanroom point light.
    const innerLightConfig = ORIGINAL_AIR_SHOWER.innerLight;
    const innerLight = new OriginalPointLight(chamberName + '-light', new Vector3(0, height - innerLightConfig.yOffset, 0), scene);
    const lightColor = rgba(config.isAmber ? 0xfef08a : 0xe0f2fe);
    innerLight.diffuse = lightColor;
    innerLight.specular = lightColor;
    innerLight.intensity = innerLightConfig.intensity;
    innerLight.range = innerLightConfig.range;
    innerLight.parent = chamber;

    // 8. Floating holographic bilingual billboard.
    const billboard = createBillboard(chamberName, config, chamber);

    return {
      config,
      group: chamber,
      indicators,
      jets,
      innerLight,
      billboard,
      // Source: group.userData.timer = Math.random() * 5.0 (staggered purge cycles).
      timer: Math.random() * 5.0,
    };
  };

  const airShowers = ORIGINAL_AIR_SHOWERS.map(config => buildAirShower(config));

  // Six multi-layer royal-blue tacky mats (source createStickyMat).
  for (const [index, matConfig] of ORIGINAL_STICKY_MATS.entries()) {
    const matName = 'original-sticky-mat-' + index;
    const matGroup = new TransformNode(matName, scene);
    matGroup.position.set(matConfig.x, 0, matConfig.z);
    matGroup.rotation.y = matConfig.rotationY;
    matGroup.parent = stickyMatsGroup;
    matGroup.metadata = { isStickyMat: true, width: matConfig.width, length: matConfig.length };
    const frameMaterial = shaded(matName + '-frame-material', 0x94a3b8, 0.85, 0.25);
    const surfaceMaterial = shaded(matName + '-surface-material', 0x1d4ed8, 0.25, 0.18);
    const tabMaterial = shaded(matName + '-tab-material', 0xffffff, 0, 0.4);
    const markMaterial = unlit(matName + '-mark-material', 0x0f172a);
    const frame = box(
      matName + '-frame',
      [matConfig.width + ORIGINAL_STICKY_MAT.frameBorder * 2, ORIGINAL_STICKY_MAT.frameThickness, matConfig.length + ORIGINAL_STICKY_MAT.frameBorder * 2],
      [0, ORIGINAL_STICKY_MAT.frameThickness / 2, 0], frameMaterial, matGroup,
    );
    frame.receiveShadows = true;
    const surface = plane(
      matName + '-surface', [matConfig.width, matConfig.length],
      [0, ORIGINAL_STICKY_MAT.frameThickness + ORIGINAL_STICKY_MAT.matOffset, 0], surfaceMaterial, matGroup, { x: Math.PI / 2 },
    );
    surface.receiveShadows = true;
    plane(
      matName + '-tab',
      [ORIGINAL_STICKY_MAT.tab.width, ORIGINAL_STICKY_MAT.tab.length],
      [matConfig.width / 2 - ORIGINAL_STICKY_MAT.tab.xInset, ORIGINAL_STICKY_MAT.frameThickness + ORIGINAL_STICKY_MAT.tab.offset, matConfig.length / 2 - ORIGINAL_STICKY_MAT.tab.zInset],
      tabMaterial, matGroup, { x: Math.PI / 2 },
    );
    plane(
      matName + '-mark',
      [ORIGINAL_STICKY_MAT.mark.width, ORIGINAL_STICKY_MAT.mark.length],
      [matConfig.width / 2 - ORIGINAL_STICKY_MAT.tab.xInset, ORIGINAL_STICKY_MAT.frameThickness + ORIGINAL_STICKY_MAT.mark.offset, matConfig.length / 2 - ORIGINAL_STICKY_MAT.tab.zInset],
      markMaterial, matGroup, { x: Math.PI / 2 },
    );
  }

  // buildCeilingFFU: deck, FFU unit matrix, LED aisles, safety trusses, cable trays.
  const ceiling = ORIGINAL_CEILING_FFU;
  const deckMaterial = shaded('original-ceiling-deck-material', 0xf8fafc, 0.1, 0.35);
  const deck = plane(
    'original-ceiling-deck', [ceiling.deck.width, ceiling.deck.depth],
    [ceiling.deck.x, ceiling.deck.y, ceiling.deck.z], deckMaterial, ceilingGroup, { x: -Math.PI / 2 },
  );
  deck.metadata = { ...noShadowCaster, isCeilingDeck: true };

  const ffuMaterial = shaded('original-ffu-unit-material', 0xe2e8f0, 0.25, 0.4);
  ORIGINAL_FFU_GRID.x.forEach((x, xIndex) => {
    ORIGINAL_FFU_GRID.z.forEach((z, zIndex) => {
      box('original-ffu-' + xIndex + '-' + zIndex,
        [ceiling.unit.width, ceiling.unit.height, ceiling.unit.depth],
        [x, ceiling.unit.y, z], ffuMaterial, ceilingGroup);
    });
  });

  const fixtureMaterial = shaded('original-ceiling-light-fixture-material', 0xcbd5e1, 0.6, 1);
  ceiling.lightAislesX.forEach((xPosition, index) => {
    box('original-ceiling-light-fixture-' + index,
      [ceiling.lightFixture.width, ceiling.lightFixture.height, ceiling.lightFixture.depth],
      [xPosition, ceiling.lightFixture.y, 0], fixtureMaterial, ceilingGroup);
    const isLithoAisle = xPosition <= ceiling.lithoAisleMaxX;
    const lightColor = isLithoAisle ? 0xf59e0b : 0xffffff;
    const lensMaterial = shaded('original-ceiling-light-lens-' + index + '-material', lightColor, 0, 0.1);
    emissive(lensMaterial, lightColor, isLithoAisle ? 1.0 : 1.25);
    box('original-ceiling-light-lens-' + index,
      [ceiling.lightLens.width, ceiling.lightLens.height, ceiling.lightLens.depth],
      [xPosition, ceiling.lightLens.y, 0], lensMaterial, ceilingGroup);
  });

  const trussMaterial = shaded('original-ceiling-truss-material', 0xeab308, 0.45, 0.35);
  const rodMaterial = shaded('original-ceiling-rod-material', 0x94a3b8, 0.8, 1);
  ORIGINAL_FFU_GRID.trussZ.forEach((z, zIndex) => {
    box('original-ceiling-truss-' + zIndex,
      [ceiling.truss.width, ceiling.truss.height, ceiling.truss.depth],
      [ceiling.truss.x, ceiling.truss.y, z], trussMaterial, ceilingGroup);
    ORIGINAL_FFU_GRID.braceX.forEach((x, xIndex) => {
      const brace1 = box('original-ceiling-brace-' + xIndex + '-' + zIndex + '-1',
        [ceiling.brace.width, ceiling.brace.height, ceiling.brace.depth],
        [x, ceiling.brace.y, z - ceiling.brace.zOffset], trussMaterial, ceilingGroup);
      brace1.rotation.x = ceiling.brace.angle;
      const brace2 = box('original-ceiling-brace-' + xIndex + '-' + zIndex + '-2',
        [ceiling.brace.width, ceiling.brace.height, ceiling.brace.depth],
        [x, ceiling.brace.y, z + ceiling.brace.zOffset], trussMaterial, ceilingGroup);
      brace2.rotation.x = -ceiling.brace.angle;
      cylinder('original-ceiling-drop-rod-' + xIndex + '-' + zIndex,
        ceiling.dropRod.radius * 2, ceiling.dropRod.radius * 2, ceiling.dropRod.height, 8,
        [x, ceiling.dropRod.y, z], rodMaterial, ceilingGroup);
    });
  });

  const trayMaterial = shaded('original-cable-tray-material', 0x94a3b8, 0.85, 0.25);
  const cableMaterial = shaded('original-cable-material', 0x0284c7, 0, 0.4);
  ceiling.cableTray.aislesX.forEach((xPosition, index) => {
    box('original-cable-tray-' + index,
      [ceiling.cableTray.width, ceiling.cableTray.height, ceiling.cableTray.depth],
      [xPosition, ceiling.cableTray.y, 0], trayMaterial, ceilingGroup);
    const cable = cylinder('original-ceiling-cable-' + index,
      ceiling.cable.radius * 2, ceiling.cable.radius * 2, ceiling.cable.depth, ceiling.cable.tessellation,
      [xPosition, ceiling.cable.y, 0], cableMaterial, ceilingGroup);
    cable.rotation.x = Math.PI / 2;
  });

  const setVisible = (visible: boolean): void => {
    group.setEnabled(visible);
    for (const chamber of airShowers) {
      // Point lights ignore TransformNode parenting for illumination; gate them explicitly.
      chamber.innerLight.setEnabled(visible);
    }
  };
  const setCeilingVisible = (visible: boolean): void => {
    ceilingGroup.setEnabled(visible);
  };
  const setLanguage = (next: FacilityLanguage): void => {
    language = next;
    for (const chamber of airShowers) {
      const billboard = chamber.billboard;
      billboard.language = next;
      const metadata = billboard.mesh.metadata as { language: FacilityLanguage };
      metadata.language = next;
      if (billboard.ctx && billboard.texture) {
        drawOriginalAirShowerBillboard(billboard.ctx, billboard.isAmber, next);
        billboard.texture.update();
      }
    }
  };

  let timelineDriven = false;
  const applyAirShowerFrames = (frames: readonly AirShowerFrame[]): void => {
    timelineDriven = true;
    for (const chamber of airShowers) {
      const frame = frames.find(value => value.id === chamber.config.equipmentId);
      if (!frame) continue;
      for (const indicator of chamber.indicators) {
        materialColor(indicator, frame.indicator.color);
        indicator.emissiveIntensity = frame.indicator.intensity;
      }
      chamber.jets.forEach((jet, index) => {
        const sample = frame.jets[index];
        if (!sample) return;
        jet.material.alpha = sample.opacity;
        jet.mesh.scaling.set(sample.scale, 1, sample.scale);
      });
      chamber.innerLight.intensity = frame.innerLight;
      chamber.billboard.mesh.position.y = frame.labelSpriteY;
    }
  };
  let lastTimeMs: number | null = null;
  const update = (timeMs: number): void => {
    if (timelineDriven) return;
    if (!Number.isFinite(timeMs)) {
      return;
    }
    const nowSec = timeMs * 0.001;
    let frames = 0;
    if (lastTimeMs !== null) {
      const deltaMs = timeMs - lastTimeMs;
      if (deltaMs > 0) {
        frames = Math.min(MAX_FRAMES_PER_UPDATE, Math.floor(deltaMs / SOURCE_FRAME_MS));
      }
    }
    lastTimeMs = timeMs;
    const source = ORIGINAL_AIR_SHOWER;
    for (const chamber of airShowers) {
      chamber.timer += source.frameSeconds * frames;
      const cycleTime = chamber.timer % source.purgeCycleSeconds;
      const blowing = cycleTime > source.purgeBlowAfterSeconds;
      if (blowing) {
        const flash = Math.sin(nowSec * 16) > 0;
        const activeColor = chamber.config.isAmber
          ? (flash ? 0xf59e0b : 0x78350f)
          : (flash ? 0x0284c7 : 0x0f172a);
        for (const indicator of chamber.indicators) {
          materialColor(indicator, activeColor);
          indicator.emissiveIntensity = flash ? 1.6 : 0.2;
        }
        chamber.jets.forEach((jet, index) => {
          jet.material.alpha = 0.55 + Math.sin(nowSec * 28 + index * 1.5) * 0.25;
          const jetScale = 0.9 + Math.sin(nowSec * 32 + index * 2.0) * 0.2;
          jet.mesh.scaling.set(jetScale, 1, jetScale);
        });
        chamber.innerLight.intensity = 1.4 + Math.sin(nowSec * 20) * 0.5;
      } else {
        for (const indicator of chamber.indicators) {
          materialColor(indicator, 0x10b981);
          indicator.emissiveIntensity = 0.8;
        }
        for (const jet of chamber.jets) {
          jet.material.alpha = 0;
        }
        chamber.innerLight.intensity = 0.35;
      }
      chamber.billboard.mesh.position.y = chamber.config.height + source.sprite.yOffset + Math.sin(nowSec * 2.2 + chamber.group.position.x) * 0.08;
    }
  };

  return { group, ceilingGroup, airShowers: airShowers.map(chamber => chamber.group), setVisible, setCeilingVisible, setLanguage, update, applyAirShowerFrames };
}

/** Typed entry point: original facility architecture shell plus the FFU ceiling grid. */
export function buildOriginalFacilityArchitecture(
  scene: Scene,
  parent: TransformNode,
  options: BuildOriginalFacilityArchitectureOptions = {},
): OriginalFacilityArchitectureController {
  return buildOriginalFacilityArchitectureInternal(scene, parent, options);
}
