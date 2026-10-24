import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import {
  ORIGINAL_SUBFAB_BOLLARD,
  ORIGINAL_SUBFAB_BOLLARDS,
  ORIGINAL_SUBFAB_CHILLER,
  ORIGINAL_SUBFAB_CHILLERS,
  ORIGINAL_SUBFAB_COUNTS,
  ORIGINAL_SUBFAB_DUCT,
  ORIGINAL_SUBFAB_DUCTS,
  ORIGINAL_SUBFAB_LIGHT,
  ORIGINAL_SUBFAB_LIGHTS,
  ORIGINAL_SUBFAB_MCC,
  ORIGINAL_SUBFAB_MCC_Z,
  ORIGINAL_SUBFAB_PUMP,
  ORIGINAL_SUBFAB_PUMPS,
  ORIGINAL_SUBFAB_SCRUBBER,
  ORIGINAL_SUBFAB_SCRUBBERS,
  ORIGINAL_SUBFAB_SECONDARY,
  ORIGINAL_SUBFAB_SECONDARY_PIPES,
  ORIGINAL_SUBFAB_WALKWAYS,
  SUBFAB_FACILITIES_GROUP_NAME,
  buildOriginalSubfabFacilities,
  type OriginalSubfabFacilitiesController,
} from '../src/original-subfab-facilities';

interface SubfabFixture {
  engine: NullEngine;
  scene: Scene;
  root: TransformNode;
  controller: OriginalSubfabFacilitiesController;
}

// CPU geometry inspection only; the product renders with WebGPU, so select the
// WGSL material-plugin language. NullEngine is not GPU acceptance.
function createSubfab(): SubfabFixture {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'isWebGPU', { value: true });
  const scene = new Scene(engine);
  const root = new TransformNode('subfab-test-root', scene);
  const controller = buildOriginalSubfabFacilities(scene, root);
  return { engine, scene, root, controller };
}

function closeSubfab(fixture: SubfabFixture): void {
  fixture.scene.dispose();
  fixture.engine.dispose();
}

function mesh(scene: Scene, name: string): Mesh {
  const found = scene.getMeshByName(name);
  if (!found) {
    throw new Error('missing mesh: ' + name);
  }
  return found as Mesh;
}

function transformNode(scene: Scene, name: string): TransformNode {
  const found = scene.getTransformNodeByName(name);
  if (!found) {
    throw new Error('missing transform node: ' + name);
  }
  return found;
}

function worldBounds(target: Mesh) {
  target.computeWorldMatrix(true);
  return target.getBoundingInfo().boundingBox;
}

function expectPoint(actual: { x: number; y: number; z: number }, expected: readonly [number, number, number]): void {
  expect(actual.x).toBeCloseTo(expected[0], 6);
  expect(actual.y).toBeCloseTo(expected[1], 6);
  expect(actual.z).toBeCloseTo(expected[2], 6);
}

function materialOf(scene: Scene, name: string): PBRMaterial {
  const material = scene.getMaterialByName(name);
  if (!material) {
    throw new Error('missing material: ' + name);
  }
  return material as PBRMaterial;
}

function meshesWithPrefix(scene: Scene, prefix: string): Mesh[] {
  return scene.meshes.filter(candidate => candidate.name.startsWith(prefix)).map(candidate => candidate as Mesh);
}

describe('original B1 subfab industrial facilities', () => {
  it('maps the source industrial material palette onto legacy-light PBR materials', () => {
    const fixture = createSubfab();
    try {
      const { scene } = fixture;
      const palette: ReadonlyArray<readonly [string, number, number, number]> = [
        ['subfab-galvanized-duct-material', 0xd8e2ec, 0.92, 0.18],
        ['subfab-galvanized-rib-material', 0x94a3b8, 0.88, 0.25],
        ['subfab-steel-channel-material', 0x334155, 0.75, 0.4],
        ['subfab-hanger-rod-material', 0x64748b, 0.9, 0.2],
        ['subfab-skid-base-material', 0x0f172a, 0.8, 0.5],
        ['subfab-pump-body-blue-material', 0x0369a1, 0.5, 0.35],
        ['subfab-pump-body-slate-material', 0x334155, 0.6, 0.3],
        ['subfab-booster-motor-material', 0x0284c7, 0.65, 0.25],
        ['subfab-stainless-bellows-material', 0xcfd8dc, 0.95, 0.15],
        ['subfab-chiller-material', 0xf1f5f9, 0.3, 0.25],
        ['subfab-rittal-cabinet-material', 0xe2e8f0, 0.45, 0.35],
        ['subfab-yellow-safety-material', 0xeab308, 0.2, 0.3],
        ['subfab-green-led-material', 0x10b981, 0, 1],
      ];
      for (const [name, color, metalness, roughness] of palette) {
        const material = materialOf(scene, name);
        expect(material.albedoColor.r, name).toBeCloseTo((color >> 16 & 255) / 255, 10);
        expect(material.albedoColor.g, name).toBeCloseTo((color >> 8 & 255) / 255, 10);
        expect(material.albedoColor.b, name).toBeCloseTo((color & 255) / 255, 10);
        expect(material.metallic, name).toBeCloseTo(metalness, 10);
        expect(material.roughness, name).toBeCloseTo(roughness, 10);
        expect(material.usePhysicalLightFalloff, name).toBe(false);
        expect(material.pluginManager?.getPlugin('OriginalLegacyLightFalloff'), name).toBeDefined();
      }
      const led = materialOf(scene, 'subfab-green-led-material');
      expect(led.emissiveColor.r).toBeCloseTo(0x10 / 255, 10);
      expect(led.emissiveColor.g).toBeCloseTo(0xb9 / 255, 10);
      expect(led.emissiveIntensity).toBeCloseTo(0.9, 10);

      ORIGINAL_SUBFAB_SECONDARY_PIPES.forEach(pipe => {
        const material = materialOf(scene, 'subfab-secondary-pipe-' + pipe.id + '-material');
        expect(material.albedoColor.r, pipe.id).toBeCloseTo((pipe.color >> 16 & 255) / 255, 10);
        expect(material.metallic, pipe.id).toBeCloseTo(0.65, 10);
        expect(material.roughness, pipe.id).toBeCloseTo(0.3, 10);
      });
      const wheel = materialOf(scene, 'subfab-secondary-pipe-CDA-valve-0-wheel-material');
      expect(wheel.albedoColor.r).toBeCloseTo(0xef / 255, 10);
      expect(wheel.metallic).toBeCloseTo(ORIGINAL_SUBFAB_SECONDARY.wheelMetalness, 10);
      expect(wheel.roughness).toBeCloseTo(1, 10);

      const louver = materialOf(scene, 'subfab-chiller-0-louver-material');
      expect(louver.albedoColor.r).toBeCloseTo(0x1e / 255, 10);
      expect(louver.roughness).toBeCloseTo(ORIGINAL_SUBFAB_CHILLER.louver.roughness, 10);
      const display = materialOf(scene, 'subfab-chiller-0-display-material');
      expect(display.emissiveColor.b).toBeCloseTo(0xc7 / 255, 10);
      expect(display.emissiveIntensity).toBeCloseTo(ORIGINAL_SUBFAB_CHILLER.display.emissiveIntensity, 10);

      // 13 shared + 5 secondary pipe + 30 valve wheel + 4 louver + 4 display materials.
      expect(scene.materials).toHaveLength(56);
      expect(scene.materials.every(material => material instanceof PBRMaterial && material.usePhysicalLightFalloff === false)).toBe(true);
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the three 94 m spiral galvanized air ducts with ribs, hangers and branch dampers', () => {
    const fixture = createSubfab();
    try {
      const { scene, controller } = fixture;
      expect(controller.group.name).toBe(SUBFAB_FACILITIES_GROUP_NAME);
      expect(controller.group.parent).toBe(fixture.root);

      ORIGINAL_SUBFAB_DUCTS.forEach((duct, index) => {
        const ductMesh = mesh(scene, 'subfab-duct-' + index);
        expectPoint(ductMesh.position, [0, duct.y, duct.z]);
        expect(ductMesh.rotation.z).toBeCloseTo(Math.PI / 2);
        expect((ductMesh.metadata as { staticShadowCaster: boolean }).staticShadowCaster).toBe(true);
        const bounds = worldBounds(ductMesh);
        expectPoint(bounds.minimumWorld, [-duct.length / 2, duct.y - duct.radius, duct.z - duct.radius]);
        expectPoint(bounds.maximumWorld, [duct.length / 2, duct.y + duct.radius, duct.z + duct.radius]);

        const rings = meshesWithPrefix(scene, 'subfab-duct-' + index + '-ring-');
        expect(rings).toHaveLength(ORIGINAL_SUBFAB_COUNTS.ductRings / ORIGINAL_SUBFAB_DUCTS.length);
        expectPoint(rings[0].position, [ORIGINAL_SUBFAB_DUCT.ringFrom, duct.y, duct.z]);
        expect(rings.at(-1)?.position.x).toBeCloseTo(ORIGINAL_SUBFAB_DUCT.ringTo, 6);
        const ringRadius = duct.radius * ORIGINAL_SUBFAB_DUCT.ringRadialScale;
        const ringBounds = worldBounds(rings[0]);
        expect(ringBounds.maximumWorld.y - ringBounds.minimumWorld.y).toBeCloseTo(ringRadius * 2, 5);
        expect(ringBounds.maximumWorld.x - ringBounds.minimumWorld.x).toBeCloseTo(ORIGINAL_SUBFAB_DUCT.ringHeight, 5);

        expect(meshesWithPrefix(scene, 'subfab-duct-' + index + '-hanger-').filter(candidate => !candidate.name.includes('-rod-'))).toHaveLength(9);
        expect(meshesWithPrefix(scene, 'subfab-duct-' + index + '-hanger-').filter(candidate => candidate.name.includes('-rod-'))).toHaveLength(18);
        const hangerBeam = mesh(scene, 'subfab-duct-' + index + '-hanger-0');
        expectPoint(hangerBeam.position, [-40, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.hangerBeamDrop, duct.z]);
        const hangerWidth = duct.radius * ORIGINAL_SUBFAB_DUCT.hangerWidthScale;
        const hangerBounds = worldBounds(hangerBeam);
        expect(hangerBounds.maximumWorld.z - hangerBounds.minimumWorld.z).toBeCloseTo(hangerWidth, 5);
        const rodHeight = Math.abs(duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.hangerBeamDrop);
        expect(worldBounds(mesh(scene, 'subfab-duct-' + index + '-hanger-0-rod-1')).maximumWorld.y - worldBounds(mesh(scene, 'subfab-duct-' + index + '-hanger-0-rod-1')).minimumWorld.y).toBeCloseTo(rodHeight, 5);

        expect(meshesWithPrefix(scene, 'subfab-duct-' + index + '-branch-').filter(candidate => !candidate.name.endsWith('-damper'))).toHaveLength(4);
        expect(meshesWithPrefix(scene, 'subfab-duct-' + index + '-branch-').filter(candidate => candidate.name.endsWith('-damper'))).toHaveLength(4);
        const branch = mesh(scene, 'subfab-duct-' + index + '-branch-0');
        expectPoint(branch.position, [-30, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.branchHeight / 2, duct.z]);
        const damper = mesh(scene, 'subfab-duct-' + index + '-branch-0-damper');
        expectPoint(damper.position, [-30, duct.y - duct.radius - ORIGINAL_SUBFAB_DUCT.damperDrop, duct.z]);
      });
      expect(meshesWithPrefix(scene, 'subfab-duct-')).toHaveLength(183);
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the five 84 m secondary process pipes with valve handwheels', () => {
    const fixture = createSubfab();
    try {
      const { scene } = fixture;
      expect(ORIGINAL_SUBFAB_SECONDARY_PIPES).toHaveLength(5);
      ORIGINAL_SUBFAB_SECONDARY_PIPES.forEach(pipe => {
        const pipeMesh = mesh(scene, 'subfab-secondary-pipe-' + pipe.id);
        expectPoint(pipeMesh.position, [0, pipe.y, pipe.z]);
        expect(pipeMesh.rotation.z).toBeCloseTo(Math.PI / 2);
        const bounds = worldBounds(pipeMesh);
        expectPoint(bounds.minimumWorld, [-ORIGINAL_SUBFAB_SECONDARY.length / 2, pipe.y - pipe.radius, pipe.z - pipe.radius]);
        expectPoint(bounds.maximumWorld, [ORIGINAL_SUBFAB_SECONDARY.length / 2, pipe.y + pipe.radius, pipe.z + pipe.radius]);

        const valves = meshesWithPrefix(scene, 'subfab-secondary-pipe-' + pipe.id + '-valve-').filter(candidate => candidate.name.endsWith('-wheel'));
        expect(valves).toHaveLength(6);
        expectPoint(valves[0].position, [ORIGINAL_SUBFAB_SECONDARY.valveFrom, pipe.y + pipe.radius + ORIGINAL_SUBFAB_SECONDARY.wheelLift, pipe.z]);
        expectPoint(valves.at(-1)?.position ?? valves[0].position, [ORIGINAL_SUBFAB_SECONDARY.valveTo, pipe.y + pipe.radius + ORIGINAL_SUBFAB_SECONDARY.wheelLift, pipe.z]);
        const wheelBounds = valves[0].getBoundingInfo().boundingBox;
        const outerDiameter = ORIGINAL_SUBFAB_SECONDARY.wheel.radius * 2 + ORIGINAL_SUBFAB_SECONDARY.wheel.tube * 2;
        expect(wheelBounds.extendSize.x * 2).toBeCloseTo(outerDiameter, 5);
        expect(wheelBounds.extendSize.y * 2).toBeCloseTo(ORIGINAL_SUBFAB_SECONDARY.wheel.tube * 2, 5);
        const stem = mesh(scene, 'subfab-secondary-pipe-' + pipe.id + '-valve-0-stem');
        expectPoint(stem.position, [ORIGINAL_SUBFAB_SECONDARY.valveFrom, pipe.y + pipe.radius + ORIGINAL_SUBFAB_SECONDARY.stemLift, pipe.z]);
      });
      expect(meshesWithPrefix(scene, 'subfab-secondary-pipe-')).toHaveLength(ORIGINAL_SUBFAB_COUNTS.secondaryPipes + ORIGINAL_SUBFAB_COUNTS.valveWheels + ORIGINAL_SUBFAB_COUNTS.valveStems);
      expect(ORIGINAL_SUBFAB_COUNTS.valves).toBe(30);
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the 21 dry vacuum pump skid banks with motors, bellows and HMI panels', () => {
    const fixture = createSubfab();
    try {
      const { scene } = fixture;
      expect(ORIGINAL_SUBFAB_COUNTS.pumpSkids).toBe(21);
      expect(ORIGINAL_SUBFAB_PUMPS).toHaveLength(21);
      ORIGINAL_SUBFAB_PUMPS.forEach((pump, index) => {
        const skid = transformNode(scene, 'subfab-pump-' + index);
        expectPoint(skid.position, [pump.x, ORIGINAL_SUBFAB_PUMP.y, pump.z]);
        expect(skid.rotation.y).toBeCloseTo(pump.rotationY);
        expect(skid.getChildMeshes()).toHaveLength(17);

        const base = mesh(scene, 'subfab-pump-' + index + '-base');
        expectPoint(base.position, [0, ORIGINAL_SUBFAB_PUMP.baseY, 0]);
        const body = mesh(scene, 'subfab-pump-' + index + '-body');
        expectPoint(body.position, [0, ORIGINAL_SUBFAB_PUMP.bodyY, ORIGINAL_SUBFAB_PUMP.bodyZ]);
        expect(body.material?.name).toBe(pump.color === 'blue' ? 'subfab-pump-body-blue-material' : 'subfab-pump-body-slate-material');
        const motor = mesh(scene, 'subfab-pump-' + index + '-motor');
        expectPoint(motor.position, [0, ORIGINAL_SUBFAB_PUMP.motorY, ORIGINAL_SUBFAB_PUMP.bodyZ]);
        expect(motor.rotation.x).toBeCloseTo(Math.PI / 2);
        expect(meshesWithPrefix(scene, 'subfab-pump-' + index + '-fin-')).toHaveLength(5);
        const bellows = mesh(scene, 'subfab-pump-' + index + '-bellows');
        expectPoint(bellows.position, [ORIGINAL_SUBFAB_PUMP.bellowsAt.x, ORIGINAL_SUBFAB_PUMP.bellowsAt.y, ORIGINAL_SUBFAB_PUMP.bellowsAt.z]);
        expect(meshesWithPrefix(scene, 'subfab-pump-' + index + '-bellows-ring-')).toHaveLength(6);
        const panel = mesh(scene, 'subfab-pump-' + index + '-panel');
        expectPoint(panel.position, [ORIGINAL_SUBFAB_PUMP.panelAt.x, ORIGINAL_SUBFAB_PUMP.panelAt.y, ORIGINAL_SUBFAB_PUMP.panelAt.z]);
        const screen = mesh(scene, 'subfab-pump-' + index + '-panel-screen');
        expect(screen.parent).toBe(panel);
        expectPoint(screen.position, [0, 0, ORIGINAL_SUBFAB_PUMP.screenZ]);
        expect(screen.rotation.y).toBeCloseTo(Math.PI);
      });
      expect(meshesWithPrefix(scene, 'subfab-pump-')).toHaveLength(ORIGINAL_SUBFAB_COUNTS.pumpMeshes);
      // Source placement banks: 12 west (alternating blue/slate) + 9 east (all blue, rotated 180 deg).
      expect(ORIGINAL_SUBFAB_PUMPS[0]).toMatchObject({ x: -30, z: -16, color: 'blue', rotationY: 0 });
      expect(ORIGINAL_SUBFAB_PUMPS[1]).toMatchObject({ x: -30, z: -8, color: 'blue' });
      expect(ORIGINAL_SUBFAB_PUMPS[2]).toMatchObject({ x: -30, z: 0, color: 'blue' });
      expect(ORIGINAL_SUBFAB_PUMPS[3]).toMatchObject({ x: -25, z: -16, color: 'slate' });
      expect(ORIGINAL_SUBFAB_PUMPS[12]).toMatchObject({ x: 18, z: -14, color: 'blue', rotationY: Math.PI });
      expect(ORIGINAL_SUBFAB_PUMPS[20]).toMatchObject({ x: 32, z: 16, color: 'blue' });
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the four point-of-use scrubbers and four process water chillers', () => {
    const fixture = createSubfab();
    try {
      const { scene } = fixture;
      expect(ORIGINAL_SUBFAB_SCRUBBERS).toHaveLength(4);
      ORIGINAL_SUBFAB_SCRUBBERS.forEach((position, index) => {
        const scrubber = transformNode(scene, 'subfab-scrubber-' + index);
        expectPoint(scrubber.position, [position.x, ORIGINAL_SUBFAB_SCRUBBER.y, position.z]);
        expect(scrubber.getChildMeshes()).toHaveLength(5);
        const column = mesh(scene, 'subfab-scrubber-' + index + '-column');
        expectPoint(column.position, [0, ORIGINAL_SUBFAB_SCRUBBER.column.y, 0]);
        expect(worldBounds(column).maximumWorld.y - worldBounds(column).minimumWorld.y).toBeCloseTo(ORIGINAL_SUBFAB_SCRUBBER.column.height, 5);
        const stack = mesh(scene, 'subfab-scrubber-' + index + '-stack');
        expectPoint(stack.position, [0, ORIGINAL_SUBFAB_SCRUBBER.stack.y, 0]);
        expect(worldBounds(stack).maximumWorld.y - worldBounds(stack).minimumWorld.y).toBeCloseTo(ORIGINAL_SUBFAB_SCRUBBER.stack.height, 5);
        const andonLight = mesh(scene, 'subfab-scrubber-' + index + '-andon-light');
        expectPoint(andonLight.position, [ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.x, ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.y, ORIGINAL_SUBFAB_SCRUBBER.andonLight.at.z]);
        expect(andonLight.material?.name).toBe('subfab-green-led-material');
        const hatch = mesh(scene, 'subfab-scrubber-' + index + '-hatch');
        expectPoint(hatch.position, [ORIGINAL_SUBFAB_SCRUBBER.hatch.at.x, ORIGINAL_SUBFAB_SCRUBBER.hatch.at.y, ORIGINAL_SUBFAB_SCRUBBER.hatch.at.z]);
        expect(hatch.rotation.x).toBeCloseTo(Math.PI / 2);
      });
      expect(meshesWithPrefix(scene, 'subfab-scrubber-')).toHaveLength(ORIGINAL_SUBFAB_COUNTS.scrubberMeshes);

      expect(ORIGINAL_SUBFAB_CHILLERS).toHaveLength(4);
      ORIGINAL_SUBFAB_CHILLERS.forEach((position, index) => {
        const chiller = transformNode(scene, 'subfab-chiller-' + index);
        expectPoint(chiller.position, [position.x, ORIGINAL_SUBFAB_CHILLER.y, position.z]);
        expect(chiller.getChildMeshes()).toHaveLength(5);
        const cabinet = mesh(scene, 'subfab-chiller-' + index + '-cabinet');
        expectPoint(cabinet.position, [0, ORIGINAL_SUBFAB_CHILLER.cabinet.y, 0]);
        const cabinetBounds = worldBounds(cabinet);
        expect(cabinetBounds.maximumWorld.y - cabinetBounds.minimumWorld.y).toBeCloseTo(ORIGINAL_SUBFAB_CHILLER.cabinet.height, 5);
        const louver = mesh(scene, 'subfab-chiller-' + index + '-louver');
        expectPoint(louver.position, [ORIGINAL_SUBFAB_CHILLER.louver.at.x, ORIGINAL_SUBFAB_CHILLER.louver.at.y, ORIGINAL_SUBFAB_CHILLER.louver.at.z]);
        expect(louver.rotation.y).toBeCloseTo(Math.PI);
        const display = mesh(scene, 'subfab-chiller-' + index + '-display');
        expectPoint(display.position, [ORIGINAL_SUBFAB_CHILLER.display.at.x, ORIGINAL_SUBFAB_CHILLER.display.at.y, ORIGINAL_SUBFAB_CHILLER.display.at.z]);
        expect(display.rotation.y).toBeCloseTo(Math.PI);
        for (const [hoseIndex, xOffset] of [-0.35, 0.35].entries()) {
          const hose = mesh(scene, 'subfab-chiller-' + index + '-hose-' + (hoseIndex + 1));
          expectPoint(hose.position, [xOffset, ORIGINAL_SUBFAB_CHILLER.hose.y, ORIGINAL_SUBFAB_CHILLER.hose.z]);
          expect(worldBounds(hose).maximumWorld.y - worldBounds(hose).minimumWorld.y).toBeCloseTo(ORIGINAL_SUBFAB_CHILLER.hose.height, 5);
        }
      });
      expect(meshesWithPrefix(scene, 'subfab-chiller-')).toHaveLength(ORIGINAL_SUBFAB_COUNTS.chillerMeshes);
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the 68 MCC switchgear cabinets with the central aisle skipped', () => {
    const fixture = createSubfab();
    try {
      const { scene } = fixture;
      expect(ORIGINAL_SUBFAB_MCC_Z).toHaveLength(34);
      expect(ORIGINAL_SUBFAB_MCC_Z.every(value => Math.abs(value) >= ORIGINAL_SUBFAB_MCC.aisleHalfWidth)).toBe(true);
      expect(ORIGINAL_SUBFAB_COUNTS.mccCabinets).toBe(68);
      const cabinets = meshesWithPrefix(scene, 'subfab-mcc-').filter(candidate => !candidate.name.endsWith('-lock'));
      const locks = meshesWithPrefix(scene, 'subfab-mcc-').filter(candidate => candidate.name.endsWith('-lock'));
      expect(cabinets).toHaveLength(68);
      expect(locks).toHaveLength(68);
      expect(meshesWithPrefix(scene, 'subfab-mcc-')).toHaveLength(ORIGINAL_SUBFAB_COUNTS.mccMeshes);
      ORIGINAL_SUBFAB_MCC.xPositions.forEach((cabinetX, sideIndex) => {
        ORIGINAL_SUBFAB_MCC_Z.forEach((cabinetZ, zIndex) => {
          const cabinet = mesh(scene, 'subfab-mcc-' + sideIndex + '-' + zIndex);
          expectPoint(cabinet.position, [cabinetX, ORIGINAL_SUBFAB_MCC.y, cabinetZ]);
          const cabinetBounds = worldBounds(cabinet);
          expectPoint(cabinetBounds.minimumWorld, [cabinetX - ORIGINAL_SUBFAB_MCC.cabinet.width / 2, -7, cabinetZ - ORIGINAL_SUBFAB_MCC.cabinet.depth / 2]);
          expectPoint(cabinetBounds.maximumWorld, [cabinetX + ORIGINAL_SUBFAB_MCC.cabinet.width / 2, -7 + ORIGINAL_SUBFAB_MCC.cabinet.height, cabinetZ + ORIGINAL_SUBFAB_MCC.cabinet.depth / 2]);
          const lock = mesh(scene, 'subfab-mcc-' + sideIndex + '-' + zIndex + '-lock');
          expect(lock.parent).toBe(cabinet);
          expectPoint(lock.position, [ORIGINAL_SUBFAB_MCC.lock.at.x, ORIGINAL_SUBFAB_MCC.lock.at.y, ORIGINAL_SUBFAB_MCC.lock.at.z]);
        });
      });
    } finally {
      closeSubfab(fixture);
    }
  });

  it('ports the yellow safety walkways/bollards and six high-bay point lights', () => {
    const fixture = createSubfab();
    try {
      const { scene, controller } = fixture;
      ORIGINAL_SUBFAB_WALKWAYS.forEach((walkway, index) => {
        const walkwayMesh = mesh(scene, 'subfab-walkway-' + index);
        expectPoint(walkwayMesh.position, [walkway.x, ORIGINAL_SUBFAB_BOLLARD.walkwayY, walkway.z]);
        expect(walkwayMesh.rotation.x).toBeCloseTo(Math.PI / 2);
        expect(walkwayMesh.receiveShadows).toBe(true);
        expect(walkwayMesh.material?.name).toBe('subfab-yellow-safety-material');
        const bounds = worldBounds(walkwayMesh);
        expect(bounds.maximumWorld.x - bounds.minimumWorld.x).toBeCloseTo(walkway.width, 5);
        expect(bounds.maximumWorld.z - bounds.minimumWorld.z).toBeCloseTo(walkway.length, 5);
      });
      ORIGINAL_SUBFAB_BOLLARDS.forEach((bollard, index) => {
        const bollardMesh = mesh(scene, 'subfab-bollard-' + index);
        expectPoint(bollardMesh.position, [bollard.x, ORIGINAL_SUBFAB_BOLLARD.y, bollard.z]);
        expect(worldBounds(bollardMesh).maximumWorld.y - worldBounds(bollardMesh).minimumWorld.y).toBeCloseTo(ORIGINAL_SUBFAB_BOLLARD.height, 5);
      });

      const lights = scene.lights.filter(light => light.name.startsWith('subfab-highbay-light-'));
      expect(lights).toHaveLength(ORIGINAL_SUBFAB_COUNTS.lights);
      ORIGINAL_SUBFAB_LIGHTS.forEach((config, index) => {
        const light = scene.getLightByName('subfab-highbay-light-' + index) as PointLight;
        expectPoint(light.position, [config.x, ORIGINAL_SUBFAB_LIGHT.y, config.z]);
        expect(light.intensity).toBeCloseTo(config.intensity, 10);
        expect(light.range).toBeCloseTo(ORIGINAL_SUBFAB_LIGHT.range, 10);
        expect(light.parent).toBe(controller.group);
      });
    } finally {
      closeSubfab(fixture);
    }
  });

  it('keeps the source B1 level switch on the whole industrial group and its lights', () => {
    const fixture = createSubfab();
    try {
      const { scene, controller } = fixture;
      expect(controller.group.isEnabled()).toBe(true);
      expect(controller.group.getChildMeshes()).toHaveLength(ORIGINAL_SUBFAB_COUNTS.meshes);
      expect(ORIGINAL_SUBFAB_COUNTS.meshes).toBe(793);
      expect(scene.meshes).toHaveLength(793);

      // Only the three source castShadow ducts are shadow casters.
      const casters = controller.group.getChildMeshes().filter(candidate => (candidate.metadata as { staticShadowCaster?: boolean } | null)?.staticShadowCaster !== false);
      expect(casters.map(candidate => candidate.name)).toEqual(['subfab-duct-0', 'subfab-duct-1', 'subfab-duct-2']);
      const nonCasters = controller.group.getChildMeshes().filter(candidate => (candidate.metadata as { staticShadowCaster?: boolean } | null)?.staticShadowCaster === false);
      expect(nonCasters).toHaveLength(790);

      controller.setVisible(false);
      expect(controller.group.isEnabled()).toBe(false);
      expect(mesh(scene, 'subfab-duct-0').isEnabled()).toBe(false);
      expect((scene.getLightByName('subfab-highbay-light-0') as PointLight).isEnabled()).toBe(false);

      controller.setVisible(true);
      expect(controller.group.isEnabled()).toBe(true);
      expect(mesh(scene, 'subfab-duct-0').isEnabled()).toBe(true);
      expect((scene.getLightByName('subfab-highbay-light-5') as PointLight).isEnabled()).toBe(true);
    } finally {
      closeSubfab(fixture);
    }
  });
});
