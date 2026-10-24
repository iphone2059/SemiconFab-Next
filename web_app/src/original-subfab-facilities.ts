import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { OriginalLegacyLightFalloff } from './original-lighting';

// Read-only port of the frozen original page (SemiconFab/twin.html),
// buildSubfabIndustrialFacilities (lines 8270-8706): the B1 subfab dense
// industrial layer (spiral galvanized air ducts, secondary process piping runs,
// dry vacuum pump skid banks, point-of-use scrubbers, process water chillers,
// MCC switchgear rows, yellow safety walkways/bollards and high-bay lighting).
//
// Coverage notes / explicit exclusions (documented in the task report):
//  * buildSubfabUtilityPipeRack (10319-10473) and buildSubfabUtilityDrops
//    (10552-10958) already have a simplified port in subfab-utilities.ts (four
//    84 m headers and the same five tool utility drops). They are NOT
//    duplicated here. The original flow-pulse additive UV sleeves, ANSI tag
//    rings, detailed through-slab flange/gasket sleeves, vibration bellows,
//    pneumatic gate valves, horizontal pump manifold bridges, PCW supply/return
//    riser pair with flow FX, VMB riser detail and trapeze-hanger detail are
//    therefore intentionally excluded.
//  * Source deliberately sets castShadow = true only on the three main air
//    ducts; every other mesh has no shadow flags. Ported via
//    metadata.staticShadowCaster (true only for the ducts) plus the sources'
//    receiveShadow flags on the safety walkways.
//  * Source B1 level toggle is a single group visibility switch; no labels or
//    billboards exist in this layer, so the controller has no setLanguage.
// Source dimensions/positions/materials are kept verbatim; THREE
// MeshStandardMaterial maps to PBRMaterial with the project legacy light
// falloff. No file of the original page is imported or modified.

export const SUBFAB_FACILITIES_GROUP_NAME = 'subfabDenseIndustrialFacilities';

export interface SubfabDuctConfig {
  readonly z: number;
  readonly y: number;
  readonly radius: number;
  readonly length: number;
}

/** Source ductConfigs lines 8344-8348. */
export const ORIGINAL_SUBFAB_DUCTS: readonly SubfabDuctConfig[] = [
  { z: -20, y: -1.7, radius: 0.68, length: 94 },
  { z: 4, y: -1.7, radius: 0.72, length: 94 },
  { z: 24, y: -1.9, radius: 0.58, length: 94 },
] as const;

export const ORIGINAL_SUBFAB_DUCT = {
  tessellation: 24,
  ringRadialScale: 1.04,
  ringHeight: 0.12,
  ringFrom: -42,
  ringTo: 42,
  ringStep: 3.5,
  hangerWidthScale: 2.6,
  hangerFrom: -40,
  hangerTo: 40,
  hangerStep: 10,
  hangerBeam: { width: 0.12, height: 0.1 },
  hangerRodRadius: 0.02,
  hangerRodTessellation: 8,
  hangerBeamDrop: 0.08,
  branchRadius: 0.32,
  branchHeight: 3.2,
  branchTessellation: 16,
  branchFrom: -30,
  branchTo: 30,
  branchStep: 20,
  damper: { width: 0.72, height: 0.45, depth: 0.72 },
  damperDrop: 1.2,
} as const;

export interface SubfabSecondaryPipe {
  readonly id: 'CDA' | 'GN2' | 'H-UPW' | 'GLYCOL' | 'AEX-D';
  readonly color: number;
  readonly radius: number;
  readonly y: number;
  readonly z: number;
}

/** Source secPipes lines 8412-8418 (all 84 m runs from x = -42 to 42). */
export const ORIGINAL_SUBFAB_SECONDARY_PIPES: readonly SubfabSecondaryPipe[] = [
  { id: 'CDA', color: 0xf8fafc, radius: 0.11, y: -2.3, z: 12.8 },
  { id: 'GN2', color: 0x94a3b8, radius: 0.1, y: -2.3, z: 13.5 },
  { id: 'H-UPW', color: 0x0284c7, radius: 0.13, y: -2.3, z: 14.2 },
  { id: 'GLYCOL', color: 0x0d9488, radius: 0.14, y: -2.3, z: 15 },
  { id: 'AEX-D', color: 0xf97316, radius: 0.16, y: -2.3, z: 15.8 },
] as const;

export const ORIGINAL_SUBFAB_SECONDARY = {
  length: 84,
  tessellation: 16,
  valveFrom: -35,
  valveTo: 35,
  valveStep: 14,
  wheel: { radius: 0.1, tube: 0.02, tessellation: 16 },
  wheelColor: 0xef4444,
  wheelMetalness: 0.4,
  wheelLift: 0.12,
  stem: { radius: 0.015, height: 0.14, tessellation: 8 },
  stemLift: 0.06,
} as const;

export interface SubfabPumpPlacement {
  readonly x: number;
  readonly z: number;
  readonly color: 'blue' | 'slate';
  readonly rotationY: number;
}

/** Source pump placement loops lines 8457-8474: 12 west + 9 east skids. */
export const ORIGINAL_SUBFAB_PUMPS: readonly SubfabPumpPlacement[] = (() => {
  const placements: SubfabPumpPlacement[] = [];
  for (let px = -30; px <= -15; px += 5) {
    for (const pz of [-16, -8, 0]) {
      placements.push({ x: px, z: pz, color: px % 10 === 0 ? 'blue' : 'slate', rotationY: 0 });
    }
  }
  for (let px = 18; px <= 32; px += 7) {
    for (const pz of [-14, 2, 16]) {
      placements.push({ x: px, z: pz, color: 'blue', rotationY: Math.PI });
    }
  }
  return placements;
})();

export const ORIGINAL_SUBFAB_PUMP = {
  y: -7,
  base: { width: 1.3, height: 0.22, depth: 2 },
  baseY: 0.11,
  body: { width: 0.85, height: 0.7, depth: 1.35 },
  bodyY: 0.22 + 0.35,
  bodyZ: -0.15,
  motor: { radius: 0.22, height: 0.85, tessellation: 16 },
  motorY: 0.22 + 0.7 + 0.22,
  fin: { radius: 0.24, height: 0.02, tessellation: 16 },
  finFrom: -0.3,
  finTo: 0.3,
  finStep: 0.15,
  bellows: { radius: 0.1, height: 4.2, tessellation: 12 },
  bellowsAt: { x: 0.25, y: 2.3, z: 0.45 },
  bellowsRing: { radius: 0.12, height: 0.04, tessellation: 12 },
  bellowsRingFrom: 0.5,
  bellowsRingTo: 4,
  bellowsRingStep: 0.6,
  panel: { width: 0.4, height: 0.3, depth: 0.08 },
  panelAt: { x: 0, y: 0.65, z: 0.65 },
  screen: { width: 0.32, height: 0.2 },
  screenZ: 0.045,
} as const;

export interface SubfabPointOfUse {
  readonly x: number;
  readonly z: number;
}

/** Source scrubberCoords lines 8541-8546 / chillerCoords lines 8586-8591. */
export const ORIGINAL_SUBFAB_SCRUBBERS: readonly SubfabPointOfUse[] = [
  { x: -36, z: -10 }, { x: -36, z: 2 }, { x: 38, z: -8 }, { x: 38, z: 12 },
] as const;

export const ORIGINAL_SUBFAB_CHILLERS: readonly SubfabPointOfUse[] = [
  { x: -8, z: -22 }, { x: -4, z: -22 }, { x: 4, z: -22 }, { x: 8, z: -22 },
] as const;

export const ORIGINAL_SUBFAB_SCRUBBER = {
  y: -7,
  column: { radius: 0.55, height: 4.2, tessellation: 20, y: 2.1 },
  stack: { radius: 0.25, height: 2.8, tessellation: 16, y: 4.2 + 1.4 },
  andonPole: { radius: 0.02, height: 0.6, tessellation: 8, at: { x: 0.35, y: 4.5, z: 0 } },
  andonLight: { radius: 0.06, height: 0.25, tessellation: 8, at: { x: 0.35, y: 4.8, z: 0 } },
  hatch: { radius: 0.22, height: 0.06, tessellation: 12, at: { x: 0, y: 1.4, z: 0.55 } },
} as const;

export const ORIGINAL_SUBFAB_CHILLER = {
  y: -7,
  cabinet: { width: 1.6, height: 2.4, depth: 1.3, y: 1.2 },
  louver: { width: 1.2, height: 1, at: { x: 0, y: 1, z: 0.66 }, color: 0x1e293b, roughness: 0.6 },
  display: { width: 0.35, height: 0.2, at: { x: 0, y: 1.9, z: 0.66 }, color: 0x0284c7, emissiveIntensity: 0.9 },
  hose: { radius: 0.04, height: 3.8, tessellation: 8, xOffset: 0.35, y: 3.8 / 2, z: -0.6 },
} as const;

export const ORIGINAL_SUBFAB_MCC = {
  xPositions: [-12, 12],
  zFrom: -18,
  zTo: 18,
  zStep: 1,
  aisleHalfWidth: 2,
  y: -7 + 1.25,
  cabinet: { width: 0.85, height: 2.5, depth: 0.75 },
  lock: { width: 0.04, height: 0.12, depth: 0.02, at: { x: 0.3, y: 0, z: 0.38 } },
} as const;

/** Source loops lines 8637-8652: two columns, skip the central aisle. */
export const ORIGINAL_SUBFAB_MCC_Z: readonly number[] = (() => {
  const values: number[] = [];
  for (let cz = ORIGINAL_SUBFAB_MCC.zFrom; cz <= ORIGINAL_SUBFAB_MCC.zTo; cz += ORIGINAL_SUBFAB_MCC.zStep) {
    if (Math.abs(cz) < ORIGINAL_SUBFAB_MCC.aisleHalfWidth) {
      continue;
    }
    values.push(cz);
  }
  return values;
})();

export const ORIGINAL_SUBFAB_WALKWAYS = [
  { x: 0, z: 0, width: 2.2, length: 68 },
  { x: -22, z: -8, width: 1.8, length: 36 },
  { x: 25, z: 4, width: 1.8, length: 40 },
  { x: 0, z: -10, width: 52, length: 1.8 },
] as const;

export const ORIGINAL_SUBFAB_BOLLARDS = [
  { x: -1.4, z: -11 }, { x: 1.4, z: -11 }, { x: -1.4, z: 11 }, { x: 1.4, z: 11 },
  { x: -20, z: -6 }, { x: -20, z: 6 }, { x: 23, z: -6 }, { x: 23, z: 6 },
] as const;

export const ORIGINAL_SUBFAB_BOLLARD = { radius: 0.06, height: 0.95, tessellation: 12, y: -7 + 0.47, walkwayY: -6.97 } as const;

export const ORIGINAL_SUBFAB_LIGHTS = [
  { x: -24, z: -12, color: 0xe0f2fe, intensity: 1.6 },
  { x: -24, z: 12, color: 0xe0f2fe, intensity: 1.6 },
  { x: 0, z: -18, color: 0xffffff, intensity: 1.8 },
  { x: 0, z: 18, color: 0xffffff, intensity: 1.8 },
  { x: 24, z: -12, color: 0xe0f2fe, intensity: 1.6 },
  { x: 24, z: 12, color: 0xe0f2fe, intensity: 1.6 },
] as const;

export const ORIGINAL_SUBFAB_LIGHT = { y: -2.2, range: 28, sourceDecay: 1.2 } as const;

const DUCT_RING_COUNT = (ORIGINAL_SUBFAB_DUCT.ringTo - ORIGINAL_SUBFAB_DUCT.ringFrom) / ORIGINAL_SUBFAB_DUCT.ringStep + 1;
const DUCT_HANGER_COUNT = (ORIGINAL_SUBFAB_DUCT.hangerTo - ORIGINAL_SUBFAB_DUCT.hangerFrom) / ORIGINAL_SUBFAB_DUCT.hangerStep + 1;
const DUCT_BRANCH_COUNT = (ORIGINAL_SUBFAB_DUCT.branchTo - ORIGINAL_SUBFAB_DUCT.branchFrom) / ORIGINAL_SUBFAB_DUCT.branchStep + 1;
const VALVE_COUNT = (ORIGINAL_SUBFAB_SECONDARY.valveTo - ORIGINAL_SUBFAB_SECONDARY.valveFrom) / ORIGINAL_SUBFAB_SECONDARY.valveStep + 1;
const PUMP_MESH_COUNT = 17;

export const ORIGINAL_SUBFAB_COUNTS = {
  ducts: ORIGINAL_SUBFAB_DUCTS.length,
  ductRings: ORIGINAL_SUBFAB_DUCTS.length * DUCT_RING_COUNT,
  ductHangerBeams: ORIGINAL_SUBFAB_DUCTS.length * DUCT_HANGER_COUNT,
  ductHangerRods: ORIGINAL_SUBFAB_DUCTS.length * DUCT_HANGER_COUNT * 2,
  ductBranches: ORIGINAL_SUBFAB_DUCTS.length * DUCT_BRANCH_COUNT,
  ductDampers: ORIGINAL_SUBFAB_DUCTS.length * DUCT_BRANCH_COUNT,
  secondaryPipes: ORIGINAL_SUBFAB_SECONDARY_PIPES.length,
  valves: ORIGINAL_SUBFAB_SECONDARY_PIPES.length * VALVE_COUNT,
  valveWheels: ORIGINAL_SUBFAB_SECONDARY_PIPES.length * VALVE_COUNT,
  valveStems: ORIGINAL_SUBFAB_SECONDARY_PIPES.length * VALVE_COUNT,
  pumpSkids: ORIGINAL_SUBFAB_PUMPS.length,
  pumpMeshes: ORIGINAL_SUBFAB_PUMPS.length * PUMP_MESH_COUNT,
  scrubbers: ORIGINAL_SUBFAB_SCRUBBERS.length,
  scrubberMeshes: ORIGINAL_SUBFAB_SCRUBBERS.length * 5,
  chillers: ORIGINAL_SUBFAB_CHILLERS.length,
  chillerMeshes: ORIGINAL_SUBFAB_CHILLERS.length * 5,
  mccCabinets: ORIGINAL_SUBFAB_MCC.xPositions.length * ORIGINAL_SUBFAB_MCC_Z.length,
  mccMeshes: ORIGINAL_SUBFAB_MCC.xPositions.length * ORIGINAL_SUBFAB_MCC_Z.length * 2,
  walkways: ORIGINAL_SUBFAB_WALKWAYS.length,
  bollards: ORIGINAL_SUBFAB_BOLLARDS.length,
  lights: ORIGINAL_SUBFAB_LIGHTS.length,
  meshes:
    ORIGINAL_SUBFAB_DUCTS.length * (1 + DUCT_RING_COUNT + DUCT_HANGER_COUNT * 3 + DUCT_BRANCH_COUNT * 2) +
    ORIGINAL_SUBFAB_SECONDARY_PIPES.length * (1 + VALVE_COUNT * 2) +
    ORIGINAL_SUBFAB_PUMPS.length * PUMP_MESH_COUNT +
    ORIGINAL_SUBFAB_SCRUBBERS.length * 5 +
    ORIGINAL_SUBFAB_CHILLERS.length * 5 +
    ORIGINAL_SUBFAB_MCC.xPositions.length * ORIGINAL_SUBFAB_MCC_Z.length * 2 +
    ORIGINAL_SUBFAB_WALKWAYS.length +
    ORIGINAL_SUBFAB_BOLLARDS.length,
} as const;

export interface OriginalSubfabFacilitiesController {
  /** Source "subfabDenseIndustrialFacilities" group. */
  readonly group: TransformNode;
  /** Source B1 level switch: group + the six high-bay point lights. */
  setVisible(visible: boolean): void;
}

export function buildOriginalSubfabFacilities(
  scene: Scene,
  parent: TransformNode,
): OriginalSubfabFacilitiesController {
  const group = new TransformNode(SUBFAB_FACILITIES_GROUP_NAME, scene);
  group.parent = parent;

  const shaded = (name: string, color: number, metalness = 0, roughness = 1): PBRMaterial => {
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
  const emissive = (material: PBRMaterial, color: number, intensity: number): PBRMaterial => {
    material.emissiveColor = Color3.FromInts(color >> 16 & 255, color >> 8 & 255, color & 255);
    material.emissiveIntensity = intensity;
    return material;
  };

  // Shared industrial materials (source lines 8276-8340).
  const galvDuct = shaded('subfab-galvanized-duct-material', 0xd8e2ec, 0.92, 0.18);
  const galvRib = shaded('subfab-galvanized-rib-material', 0x94a3b8, 0.88, 0.25);
  const steelChannel = shaded('subfab-steel-channel-material', 0x334155, 0.75, 0.4);
  const hangerRod = shaded('subfab-hanger-rod-material', 0x64748b, 0.9, 0.2);
  const skidBase = shaded('subfab-skid-base-material', 0x0f172a, 0.8, 0.5);
  const pumpBodyBlue = shaded('subfab-pump-body-blue-material', 0x0369a1, 0.5, 0.35);
  const pumpBodySlate = shaded('subfab-pump-body-slate-material', 0x334155, 0.6, 0.3);
  const boosterMotor = shaded('subfab-booster-motor-material', 0x0284c7, 0.65, 0.25);
  const ssBellows = shaded('subfab-stainless-bellows-material', 0xcfd8dc, 0.95, 0.15);
  const chillerMaterial = shaded('subfab-chiller-material', 0xf1f5f9, 0.3, 0.25);
  const rittalCabinet = shaded('subfab-rittal-cabinet-material', 0xe2e8f0, 0.45, 0.35);
  const yellowSafety = shaded('subfab-yellow-safety-material', 0xeab308, 0.2, 0.3);
  const greenLed = emissive(shaded('subfab-green-led-material', 0x10b981), 0x10b981, 0.9);

  const noCaster = { staticShadowCaster: false } as const;
  const addBox = (
    name: string,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material: PBRMaterial,
    target: TransformNode,
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.material = material;
    mesh.parent = target;
    mesh.isPickable = false;
    mesh.metadata = { ...noCaster };
    return mesh;
  };
  const addCylinder = (
    name: string,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    tessellation: number,
    at: readonly [number, number, number],
    material: PBRMaterial,
    target: TransformNode,
  ): Mesh => {
    const mesh = MeshBuilder.CreateCylinder(name, {
      diameterTop: radiusTop * 2, diameterBottom: radiusBottom * 2, height, tessellation,
    }, scene);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.material = material;
    mesh.parent = target;
    mesh.isPickable = false;
    mesh.metadata = { ...noCaster };
    return mesh;
  };
  const addPlane = (
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
    mesh.metadata = { ...noCaster };
    return mesh;
  };

  // 1. Three massive spiral galvanized air ducts with ribs, trapeze hangers and branch dampers.
  ORIGINAL_SUBFAB_DUCTS.forEach((duct, ductIndex) => {
    const ductName = 'subfab-duct-' + ductIndex;
    const ductMesh = addCylinder(
      ductName, duct.radius, duct.radius, duct.length, ORIGINAL_SUBFAB_DUCT.tessellation,
      [0, duct.y, duct.z], galvDuct, group,
    );
    ductMesh.rotation.z = Math.PI / 2;
    // Source: ductMesh.castShadow = true (the only shadow casters in this layer).
    ductMesh.metadata = { staticShadowCaster: true };

    const ringRadius = duct.radius * ORIGINAL_SUBFAB_DUCT.ringRadialScale;
    let ringIndex = 0;
    for (let ringX = ORIGINAL_SUBFAB_DUCT.ringFrom; ringX <= ORIGINAL_SUBFAB_DUCT.ringTo; ringX += ORIGINAL_SUBFAB_DUCT.ringStep) {
      const ring = addCylinder(
        ductName + '-ring-' + ringIndex, ringRadius, ringRadius, ORIGINAL_SUBFAB_DUCT.ringHeight,
        ORIGINAL_SUBFAB_DUCT.tessellation, [ringX, duct.y, duct.z], galvRib, group,
      );
      ring.rotation.z = Math.PI / 2;
      ringIndex++;
    }

    const hangerWidth = duct.radius * ORIGINAL_SUBFAB_DUCT.hangerWidthScale;
    let hangerIndex = 0;
    for (let hangerX = ORIGINAL_SUBFAB_DUCT.hangerFrom; hangerX <= ORIGINAL_SUBFAB_DUCT.hangerTo; hangerX += ORIGINAL_SUBFAB_DUCT.hangerStep) {
      addBox(
        ductName + '-hanger-' + hangerIndex,
        [ORIGINAL_SUBFAB_DUCT.hangerBeam.width, ORIGINAL_SUBFAB_DUCT.hangerBeam.height, hangerWidth],
        [hangerX, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.hangerBeamDrop, duct.z], steelChannel, group,
      );
      const rodHeight = Math.abs(duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.hangerBeamDrop);
      for (const [rodIndex, rodZ] of [duct.z - hangerWidth / 2 + 0.08, duct.z + hangerWidth / 2 - 0.08].entries()) {
        addCylinder(
          ductName + '-hanger-' + hangerIndex + '-rod-' + (rodIndex + 1),
          ORIGINAL_SUBFAB_DUCT.hangerRodRadius, ORIGINAL_SUBFAB_DUCT.hangerRodRadius, rodHeight,
          ORIGINAL_SUBFAB_DUCT.hangerRodTessellation, [hangerX, -rodHeight / 2, rodZ], hangerRod, group,
        );
      }
      hangerIndex++;
    }

    let branchIndex = 0;
    for (let branchX = ORIGINAL_SUBFAB_DUCT.branchFrom; branchX <= ORIGINAL_SUBFAB_DUCT.branchTo; branchX += ORIGINAL_SUBFAB_DUCT.branchStep) {
      addCylinder(
        ductName + '-branch-' + branchIndex,
        ORIGINAL_SUBFAB_DUCT.branchRadius, ORIGINAL_SUBFAB_DUCT.branchRadius, ORIGINAL_SUBFAB_DUCT.branchHeight,
        ORIGINAL_SUBFAB_DUCT.branchTessellation,
        [branchX, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.branchHeight / 2, duct.z], galvDuct, group,
      );
      addBox(
        ductName + '-branch-' + branchIndex + '-damper',
        [ORIGINAL_SUBFAB_DUCT.damper.width, ORIGINAL_SUBFAB_DUCT.damper.height, ORIGINAL_SUBFAB_DUCT.damper.depth],
        [branchX, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.damperDrop, duct.z], steelChannel, group,
      );
      branchIndex++;
    }
  });

  // 2. Secondary process piping runs at z = 12.8 .. 15.8 with red valve handwheels/gauges.
  for (const pipe of ORIGINAL_SUBFAB_SECONDARY_PIPES) {
    const pipeName = 'subfab-secondary-pipe-' + pipe.id;
    const pipeMaterial = shaded(pipeName + '-material', pipe.color, 0.65, 0.3);
    const pipeMesh = addCylinder(
      pipeName, pipe.radius, pipe.radius, ORIGINAL_SUBFAB_SECONDARY.length, ORIGINAL_SUBFAB_SECONDARY.tessellation,
      [0, pipe.y, pipe.z], pipeMaterial, group,
    );
    pipeMesh.rotation.z = Math.PI / 2;

    let valveIndex = 0;
    for (let valveX = ORIGINAL_SUBFAB_SECONDARY.valveFrom; valveX <= ORIGINAL_SUBFAB_SECONDARY.valveTo; valveX += ORIGINAL_SUBFAB_SECONDARY.valveStep) {
      const valveMaterial = shaded(pipeName + '-valve-' + valveIndex + '-wheel-material', ORIGINAL_SUBFAB_SECONDARY.wheelColor, ORIGINAL_SUBFAB_SECONDARY.wheelMetalness, 1);
      const wheel = MeshBuilder.CreateTorus(pipeName + '-valve-' + valveIndex + '-wheel', {
        diameter: ORIGINAL_SUBFAB_SECONDARY.wheel.radius * 2,
        thickness: ORIGINAL_SUBFAB_SECONDARY.wheel.tube * 2,
        tessellation: ORIGINAL_SUBFAB_SECONDARY.wheel.tessellation,
      }, scene);
      // Babylon torus already lies in the XZ plane (axis Y), the final orientation
      // the source reaches after wheel.rotation.x = Math.PI / 2.
      wheel.position.set(valveX, pipe.y + pipe.radius + ORIGINAL_SUBFAB_SECONDARY.wheelLift, pipe.z);
      wheel.material = valveMaterial;
      wheel.parent = group;
      wheel.isPickable = false;
      wheel.metadata = { ...noCaster };
      addCylinder(
        pipeName + '-valve-' + valveIndex + '-stem',
        ORIGINAL_SUBFAB_SECONDARY.stem.radius, ORIGINAL_SUBFAB_SECONDARY.stem.radius,
        ORIGINAL_SUBFAB_SECONDARY.stem.height, ORIGINAL_SUBFAB_SECONDARY.stem.tessellation,
        [valveX, pipe.y + pipe.radius + ORIGINAL_SUBFAB_SECONDARY.stemLift, pipe.z], steelChannel, group,
      );
      valveIndex++;
    }
  }

  // 3. Twenty-one dry vacuum pump skids on banks west/east of the B1 floor.
  for (const [pumpIndex, pump] of ORIGINAL_SUBFAB_PUMPS.entries()) {
    const pumpName = 'subfab-pump-' + pumpIndex;
    const skid = new TransformNode(pumpName, scene);
    skid.position.set(pump.x, ORIGINAL_SUBFAB_PUMP.y, pump.z);
    skid.rotation.y = pump.rotationY;
    skid.parent = group;
    skid.metadata = { isDryPumpSkid: true, color: pump.color };

    addBox(pumpName + '-base', [ORIGINAL_SUBFAB_PUMP.base.width, ORIGINAL_SUBFAB_PUMP.base.height, ORIGINAL_SUBFAB_PUMP.base.depth], [0, ORIGINAL_SUBFAB_PUMP.baseY, 0], skidBase, skid);
    addBox(
      pumpName + '-body',
      [ORIGINAL_SUBFAB_PUMP.body.width, ORIGINAL_SUBFAB_PUMP.body.height, ORIGINAL_SUBFAB_PUMP.body.depth],
      [0, ORIGINAL_SUBFAB_PUMP.bodyY, ORIGINAL_SUBFAB_PUMP.bodyZ],
      pump.color === 'blue' ? pumpBodyBlue : pumpBodySlate, skid,
    );
    const motor = addCylinder(
      pumpName + '-motor',
      ORIGINAL_SUBFAB_PUMP.motor.radius, ORIGINAL_SUBFAB_PUMP.motor.radius, ORIGINAL_SUBFAB_PUMP.motor.height,
      ORIGINAL_SUBFAB_PUMP.motor.tessellation,
      [0, ORIGINAL_SUBFAB_PUMP.motorY, ORIGINAL_SUBFAB_PUMP.bodyZ], boosterMotor, skid,
    );
    motor.rotation.x = Math.PI / 2;
    let finIndex = 0;
    for (let finOffset = ORIGINAL_SUBFAB_PUMP.finFrom; finOffset <= ORIGINAL_SUBFAB_PUMP.finTo; finOffset += ORIGINAL_SUBFAB_PUMP.finStep) {
      const fin = addCylinder(
        pumpName + '-fin-' + finIndex,
        ORIGINAL_SUBFAB_PUMP.fin.radius, ORIGINAL_SUBFAB_PUMP.fin.radius, ORIGINAL_SUBFAB_PUMP.fin.height,
        ORIGINAL_SUBFAB_PUMP.fin.tessellation,
        [0, ORIGINAL_SUBFAB_PUMP.motorY, ORIGINAL_SUBFAB_PUMP.bodyZ + finOffset], steelChannel, skid,
      );
      fin.rotation.x = Math.PI / 2;
      finIndex++;
    }
    addCylinder(
      pumpName + '-bellows',
      ORIGINAL_SUBFAB_PUMP.bellows.radius, ORIGINAL_SUBFAB_PUMP.bellows.radius, ORIGINAL_SUBFAB_PUMP.bellows.height,
      ORIGINAL_SUBFAB_PUMP.bellows.tessellation,
      [ORIGINAL_SUBFAB_PUMP.bellowsAt.x, ORIGINAL_SUBFAB_PUMP.bellowsAt.y, ORIGINAL_SUBFAB_PUMP.bellowsAt.z], ssBellows, skid,
    );
    let bellowsRingIndex = 0;
    for (let ringY = ORIGINAL_SUBFAB_PUMP.bellowsRingFrom; ringY < ORIGINAL_SUBFAB_PUMP.bellowsRingTo; ringY += ORIGINAL_SUBFAB_PUMP.bellowsRingStep) {
      addCylinder(
        pumpName + '-bellows-ring-' + bellowsRingIndex,
        ORIGINAL_SUBFAB_PUMP.bellowsRing.radius, ORIGINAL_SUBFAB_PUMP.bellowsRing.radius, ORIGINAL_SUBFAB_PUMP.bellowsRing.height,
        ORIGINAL_SUBFAB_PUMP.bellowsRing.tessellation,
        [ORIGINAL_SUBFAB_PUMP.bellowsAt.x, ringY, ORIGINAL_SUBFAB_PUMP.bellowsAt.z], galvRib, skid,
      );
      bellowsRingIndex++;
    }
    const panel = addBox(
      pumpName + '-panel',
      [ORIGINAL_SUBFAB_PUMP.panel.width, ORIGINAL_SUBFAB_PUMP.panel.height, ORIGINAL_SUBFAB_PUMP.panel.depth],
      [ORIGINAL_SUBFAB_PUMP.panelAt.x, ORIGINAL_SUBFAB_PUMP.panelAt.y, ORIGINAL_SUBFAB_PUMP.panelAt.z], steelChannel, skid,
    );
    addPlane(
      pumpName + '-panel-screen',
      [ORIGINAL_SUBFAB_PUMP.screen.width, ORIGINAL_SUBFAB_PUMP.screen.height],
      [0, 0, ORIGINAL_SUBFAB_PUMP.screenZ], greenLed, panel, { y: Math.PI },
    );
  }

  // 4. Point-of-use gas scrubbers / abatement units.
  for (const [scrubberIndex, position] of ORIGINAL_SUBFAB_SCRUBBERS.entries()) {
    const scrubberName = 'subfab-scrubber-' + scrubberIndex;
    const scrubber = new TransformNode(scrubberName, scene);
    scrubber.position.set(position.x, ORIGINAL_SUBFAB_SCRUBBER.y, position.z);
    scrubber.parent = group;
    scrubber.metadata = { isPointOfUseScrubber: true };
    addCylinder(
      scrubberName + '-column',
      ORIGINAL_SUBFAB_SCRUBBER.column.radius, ORIGINAL_SUBFAB_SCRUBBER.column.radius, ORIGINAL_SUBFAB_SCRUBBER.column.height,
      ORIGINAL_SUBFAB_SCRUBBER.column.tessellation, [0, ORIGINAL_SUBFAB_SCRUBBER.column.y, 0], ssBellows, scrubber,
    );
    addCylinder(
      scrubberName + '-stack',
      ORIGINAL_SUBFAB_SCRUBBER.stack.radius, ORIGINAL_SUBFAB_SCRUBBER.stack.radius, ORIGINAL_SUBFAB_SCRUBBER.stack.height,
      ORIGINAL_SUBFAB_SCRUBBER.stack.tessellation, [0, ORIGINAL_SUBFAB_SCRUBBER.stack.y, 0], galvDuct, scrubber,
    );
    addCylinder(
      scrubberName + '-andon-pole',
      ORIGINAL_SUBFAB_SCRUBBER.andonPole.radius, ORIGINAL_SUBFAB_SCRUBBER.andonPole.radius, ORIGINAL_SUBFAB_SCRUBBER.andonPole.height,
      ORIGINAL_SUBFAB_SCRUBBER.andonPole.tessellation,
      [ORIGINAL_SUBFAB_SCRUBBER.andonPole.at.x, ORIGINAL_SUBFAB_SCRUBBER.andonPole.at.y, ORIGINAL_SUBFAB_SCRUBBER.andonPole.at.z],
      hangerRod, scrubber,
    );
    addCylinder(
      scrubberName + '-andon-light',
      ORIGINAL_SUBFAB_SCRUBBER.andonLight.radius, ORIGINAL_SUBFAB_SCRUBBER.andonLight.radius, ORIGINAL_SUBFAB_SCRUBBER.andonLight.height,
      ORIGINAL_SUBFAB_SCRUBBER.andonLight.tessellation,
      [ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.x, ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.y, ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.z],
      greenLed, scrubber,
    );
    const hatch = addCylinder(
      scrubberName + '-hatch',
      ORIGINAL_SUBFAB_SCRUBBER.hatch.radius, ORIGINAL_SUBFAB_SCRUBBER.hatch.radius, ORIGINAL_SUBFAB_SCRUBBER.hatch.height,
      ORIGINAL_SUBFAB_SCRUBBER.hatch.tessellation,
      [ORIGINAL_SUBFAB_SCRUBBER.hatch.at.x, ORIGINAL_SUBFAB_SCRUBBER.hatch.at.y, ORIGINAL_SUBFAB_SCRUBBER.hatch.at.z],
      steelChannel, scrubber,
    );
    hatch.rotation.x = Math.PI / 2;
  }

  // 5. Process water chillers / heat exchanger cabinets.
  for (const [chillerIndex, position] of ORIGINAL_SUBFAB_CHILLERS.entries()) {
    const chillerName = 'subfab-chiller-' + chillerIndex;
    const chiller = new TransformNode(chillerName, scene);
    chiller.position.set(position.x, ORIGINAL_SUBFAB_CHILLER.y, position.z);
    chiller.parent = group;
    chiller.metadata = { isProcessChiller: true };
    addBox(
      chillerName + '-cabinet',
      [ORIGINAL_SUBFAB_CHILLER.cabinet.width, ORIGINAL_SUBFAB_CHILLER.cabinet.height, ORIGINAL_SUBFAB_CHILLER.cabinet.depth],
      [0, ORIGINAL_SUBFAB_CHILLER.cabinet.y, 0], chillerMaterial, chiller,
    );
    const louverConfig = ORIGINAL_SUBFAB_CHILLER.louver;
    const louverMaterial = shaded(chillerName + '-louver-material', louverConfig.color, 0, louverConfig.roughness);
    addPlane(
      chillerName + '-louver',
      [louverConfig.width, louverConfig.height],
      [louverConfig.at.x, louverConfig.at.y, louverConfig.at.z], louverMaterial, chiller, { y: Math.PI },
    );
    const displayConfig = ORIGINAL_SUBFAB_CHILLER.display;
    const displayMaterial = emissive(shaded(chillerName + '-display-material', displayConfig.color), displayConfig.color, displayConfig.emissiveIntensity);
    addPlane(
      chillerName + '-display',
      [displayConfig.width, displayConfig.height],
      [displayConfig.at.x, displayConfig.at.y, displayConfig.at.z], displayMaterial, chiller, { y: Math.PI },
    );
    for (const [hoseIndex, xOffset] of [-ORIGINAL_SUBFAB_CHILLER.hose.xOffset, ORIGINAL_SUBFAB_CHILLER.hose.xOffset].entries()) {
      addCylinder(
        chillerName + '-hose-' + (hoseIndex + 1),
        ORIGINAL_SUBFAB_CHILLER.hose.radius, ORIGINAL_SUBFAB_CHILLER.hose.radius, ORIGINAL_SUBFAB_CHILLER.hose.height,
        ORIGINAL_SUBFAB_CHILLER.hose.tessellation,
        [xOffset, ORIGINAL_SUBFAB_CHILLER.hose.y, ORIGINAL_SUBFAB_CHILLER.hose.z], pumpBodyBlue, chiller,
      );
    }
  }

  // 6. MCC electrical switchgear cabinet rows (central aisle skipped).
  for (const [sideIndex, cabinetX] of ORIGINAL_SUBFAB_MCC.xPositions.entries()) {
    for (const [zIndex, cabinetZ] of ORIGINAL_SUBFAB_MCC_Z.entries()) {
      const cabinetName = 'subfab-mcc-' + sideIndex + '-' + zIndex;
      const cabinet = addBox(
        cabinetName,
        [ORIGINAL_SUBFAB_MCC.cabinet.width, ORIGINAL_SUBFAB_MCC.cabinet.height, ORIGINAL_SUBFAB_MCC.cabinet.depth],
        [cabinetX, ORIGINAL_SUBFAB_MCC.y, cabinetZ], rittalCabinet, group,
      );
      cabinet.metadata = { ...noCaster, isMccCabinet: true, gridX: cabinetX, gridZ: cabinetZ };
      addBox(
        cabinetName + '-lock',
        [ORIGINAL_SUBFAB_MCC.lock.width, ORIGINAL_SUBFAB_MCC.lock.height, ORIGINAL_SUBFAB_MCC.lock.depth],
        [ORIGINAL_SUBFAB_MCC.lock.at.x, ORIGINAL_SUBFAB_MCC.lock.at.y, ORIGINAL_SUBFAB_MCC.lock.at.z], steelChannel, cabinet,
      );
    }
  }

  // 7. Yellow epoxy safety walkways and bollards.
  for (const [walkwayIndex, walkway] of ORIGINAL_SUBFAB_WALKWAYS.entries()) {
    const walkwayMesh = addPlane(
      'subfab-walkway-' + walkwayIndex,
      [walkway.width, walkway.length],
      [walkway.x, ORIGINAL_SUBFAB_BOLLARD.walkwayY, walkway.z], yellowSafety, group, { x: Math.PI / 2 },
    );
    walkwayMesh.receiveShadows = true;
  }
  for (const [bollardIndex, bollard] of ORIGINAL_SUBFAB_BOLLARDS.entries()) {
    addCylinder(
      'subfab-bollard-' + bollardIndex,
      ORIGINAL_SUBFAB_BOLLARD.radius, ORIGINAL_SUBFAB_BOLLARD.radius, ORIGINAL_SUBFAB_BOLLARD.height,
      ORIGINAL_SUBFAB_BOLLARD.tessellation, [bollard.x, ORIGINAL_SUBFAB_BOLLARD.y, bollard.z], yellowSafety, group,
    );
  }

  // 8. Industrial high-bay daylight point lights (source decay 1.2 has no Babylon
  // equivalent; the project legacy-light-falloff PBR materials are used instead).
  const lights: PointLight[] = [];
  for (const [lightIndex, config] of ORIGINAL_SUBFAB_LIGHTS.entries()) {
    const light = new PointLight('subfab-highbay-light-' + lightIndex, new Vector3(config.x, ORIGINAL_SUBFAB_LIGHT.y, config.z), scene);
    light.diffuse = Color3.FromInts(config.color >> 16 & 255, config.color >> 8 & 255, config.color & 255);
    light.specular = light.diffuse.clone();
    light.intensity = config.intensity;
    light.range = ORIGINAL_SUBFAB_LIGHT.range;
    light.parent = group;
    lights.push(light);
  }

  const setVisible = (visible: boolean): void => {
    group.setEnabled(visible);
    // Lights ignore TransformNode enabling for illumination; gate them explicitly.
    for (const light of lights) {
      light.setEnabled(visible);
    }
  };

  return { group, setVisible };
}
