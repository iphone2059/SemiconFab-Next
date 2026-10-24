import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import {
  AIR_SHOWER_CHAMBERS_GROUP_NAME,
  AIR_SHOWER_SPRITE_CANVAS,
  CEILING_FFU_GROUP_NAME,
  FACILITY_ARCHITECTURE_GROUP_NAME,
  ORIGINAL_AIR_SHOWER,
  ORIGINAL_AIR_SHOWERS,
  ORIGINAL_CEILING_FFU,
  ORIGINAL_FACILITY_COUNTS,
  ORIGINAL_FFU_GRID,
  ORIGINAL_STICKY_MAT,
  ORIGINAL_STICKY_MATS,
  STICKY_MATS_GROUP_NAME,
  buildOriginalFacilityArchitecture,
  drawOriginalAirShowerBillboard,
  type FacilityCanvasContext,
  type OriginalFacilityArchitectureController,
} from '../src/original-facility-architecture';

interface FacilityFixture {
  engine: NullEngine;
  scene: Scene;
  root: TransformNode;
  controller: OriginalFacilityArchitectureController;
}

// CPU geometry inspection only; the product renders with WebGPU so select the
// WGSL material-plugin language. NullEngine is not GPU acceptance.
function createFacility(options: { language?: 'zh' | 'en' } = {}): FacilityFixture {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'isWebGPU', { value: true });
  const scene = new Scene(engine);
  const root = new TransformNode('facility-test-root', scene);
  const controller = buildOriginalFacilityArchitecture(scene, root, options);
  return { engine, scene, root, controller };
}

function closeFacility(fixture: FacilityFixture): void {
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

function chamberMeshCount(scene: Scene, chamberName: string): number {
  const chamber = scene.getTransformNodeByName(chamberName);
  if (!chamber) {
    throw new Error('missing chamber: ' + chamberName);
  }
  return chamber.getChildMeshes().length;
}

function meshesWithPrefix(scene: Scene, prefix: string): Mesh[] {
  return scene.meshes.filter(candidate => candidate.name.startsWith(prefix)).map(candidate => candidate as Mesh);
}

describe('original facility architecture shell', () => {
  it('maps the source standard/physical materials onto legacy-light PBR materials', () => {
    const fixture = createFacility();
    try {
      const palette: ReadonlyArray<readonly [string, number, number, number]> = [
        ['original-airshower-main-stainless-material', 0xd8e0e9, 0.9, 0.22],
        ['original-airshower-main-dark-trim-material', 0x1e293b, 0, 0.5],
        ['original-airshower-main-nozzle-material', 0x94a3b8, 0.95, 0.1],
        ['original-airshower-litho-stainless-material', 0xd8e0e9, 0.9, 0.22],
        ['original-ceiling-deck-material', 0xf8fafc, 0.1, 0.35],
        ['original-ffu-unit-material', 0xe2e8f0, 0.25, 0.4],
        ['original-ceiling-light-fixture-material', 0xcbd5e1, 0.6, 1],
        ['original-ceiling-truss-material', 0xeab308, 0.45, 0.35],
        ['original-ceiling-rod-material', 0x94a3b8, 0.8, 1],
        ['original-cable-tray-material', 0x94a3b8, 0.85, 0.25],
        ['original-cable-material', 0x0284c7, 0, 0.4],
        ['original-sticky-mat-0-frame-material', 0x94a3b8, 0.85, 0.25],
        ['original-sticky-mat-0-surface-material', 0x1d4ed8, 0.25, 0.18],
        ['original-sticky-mat-0-tab-material', 0xffffff, 0, 0.4],
      ];
      for (const [name, color, metalness, roughness] of palette) {
        const material = materialOf(fixture.scene, name);
        expect(material.albedoColor.r, name).toBeCloseTo((color >> 16 & 255) / 255, 10);
        expect(material.albedoColor.g, name).toBeCloseTo((color >> 8 & 255) / 255, 10);
        expect(material.albedoColor.b, name).toBeCloseTo((color & 255) / 255, 10);
        expect(material.metallic, name).toBeCloseTo(metalness, 10);
        expect(material.roughness, name).toBeCloseTo(roughness, 10);
        expect(material.usePhysicalLightFalloff, name).toBe(false);
        expect(material.pluginManager?.getPlugin('OriginalLegacyLightFalloff'), name).toBeDefined();
      }

      const mainGlass = materialOf(fixture.scene, 'original-airshower-main-glass-material');
      expect(mainGlass.albedoColor.r).toBeCloseTo(0x38 / 255, 10);
      expect(mainGlass.alpha).toBeCloseTo(0.35, 10);
      expect(mainGlass.roughness).toBeCloseTo(0.1, 10);
      expect(mainGlass.indexOfRefraction).toBeCloseTo(1.5, 10);
      expect(mainGlass.subSurface.isRefractionEnabled).toBe(true);
      expect(mainGlass.subSurface.refractionIntensity).toBeCloseTo(0.8, 10);
      const lithoGlass = materialOf(fixture.scene, 'original-airshower-litho-glass-material');
      expect(lithoGlass.albedoColor.r).toBeCloseTo(0xf5 / 255, 10);
      expect(lithoGlass.alpha).toBeCloseTo(0.55, 10);

      const mark = materialOf(fixture.scene, 'original-sticky-mat-0-mark-material');
      expect(mark.unlit).toBe(true);
      const amberLens = materialOf(fixture.scene, 'original-ceiling-light-lens-0-material');
      expect(amberLens.albedoColor.r).toBeCloseTo(0xf5 / 255, 10);
      expect(amberLens.emissiveIntensity).toBeCloseTo(1.0, 10);
      const whiteLens = materialOf(fixture.scene, 'original-ceiling-light-lens-2-material');
      expect(whiteLens.albedoColor.r).toBeCloseTo(1, 10);
      expect(whiteLens.emissiveIntensity).toBeCloseTo(1.25, 10);

      const indicator = materialOf(fixture.scene, 'original-airshower-main-indicator-0-material');
      expect(indicator.albedoColor.g).toBeCloseTo(0xb9 / 255, 10);
      expect(indicator.emissiveIntensity).toBeCloseTo(0.8, 10);

      const jet = materialOf(fixture.scene, 'original-airshower-main-jet-0-material');
      expect(jet.unlit).toBe(true);
      expect(jet.alpha).toBeCloseTo(0, 10);
      expect(jet.alphaMode).toBe(Constants.ALPHA_ADD);
      expect(jet.backFaceCulling).toBe(false);

      const billboard = materialOf(fixture.scene, 'original-airshower-main-billboard-material');
      expect(billboard.unlit).toBe(true);
      expect(billboard.depthFunction).toBe(Constants.ALWAYS);
      expect(billboard.disableDepthWrite).toBe(true);
    } finally {
      closeFacility(fixture);
    }
  });

  it('ports the two source air shower airlocks at their original positions and dimensions', () => {
    const fixture = createFacility();
    try {
      const { scene, controller } = fixture;
      expect(controller.group.name).toBe(FACILITY_ARCHITECTURE_GROUP_NAME);
      expect(controller.group.parent).toBe(fixture.root);
      expect(scene.getTransformNodeByName(AIR_SHOWER_CHAMBERS_GROUP_NAME)?.parent).toBe(controller.group);
      expect(scene.getTransformNodeByName(STICKY_MATS_GROUP_NAME)?.parent).toBe(controller.group);
      expect(scene.getTransformNodeByName(CEILING_FFU_GROUP_NAME)?.parent).toBe(controller.group);

      expect(controller.airShowers).toHaveLength(ORIGINAL_FACILITY_COUNTS.airShowers);
      ORIGINAL_AIR_SHOWERS.forEach((config, index) => {
        const chamberName = 'original-airshower-' + config.id;
        expect(controller.airShowers[index].name).toBe(chamberName);
        expectPoint(controller.airShowers[index].position, [config.x, 0, config.z]);
        expect(controller.airShowers[index].metadata).toMatchObject({
          equipmentId: config.equipmentId,
          isAirShower: true,
          isAmber: config.isAmber,
          width: config.width,
          height: config.height,
          depth: config.depth,
        });
        // walls 2 + top 1 + nozzles 18 + doors 2 + windows 2 + indicators 2 + hmi 1 + screen 1 + jets 4 + billboard 1
        expect(chamberMeshCount(scene, chamberName)).toBe(34);

        const wallThickness = ORIGINAL_AIR_SHOWER.wallThickness;
        const halfWidth = config.width / 2;
        const halfDepth = config.depth / 2;
        const leftWall = mesh(scene, chamberName + '-plenum-left');
        expectPoint(leftWall.position, [-halfWidth + wallThickness / 2, config.height / 2, 0]);
        const leftBounds = worldBounds(leftWall);
        expectPoint(leftBounds.minimumWorld, [config.x - halfWidth, 0, config.z - halfDepth]);
        expectPoint(leftBounds.maximumWorld, [config.x - halfWidth + wallThickness, config.height, config.z + halfDepth]);
        const rightWall = mesh(scene, chamberName + '-plenum-right');
        expectPoint(rightWall.position, [halfWidth - wallThickness / 2, config.height / 2, 0]);

        const top = mesh(scene, chamberName + '-top-plenum');
        expectPoint(top.position, [0, config.height - ORIGINAL_AIR_SHOWER.topOffset, 0]);
        const topBounds = worldBounds(top);
        expectPoint(topBounds.minimumWorld, [config.x - halfWidth, config.height - ORIGINAL_AIR_SHOWER.topOffset - ORIGINAL_AIR_SHOWER.topHeight / 2, config.z - halfDepth]);
        expectPoint(topBounds.maximumWorld, [config.x + halfWidth, config.height - ORIGINAL_AIR_SHOWER.topOffset + ORIGINAL_AIR_SHOWER.topHeight / 2, config.z + halfDepth]);

        const nozzles = meshesWithPrefix(scene, chamberName + '-nozzle-');
        expect(nozzles).toHaveLength(ORIGINAL_AIR_SHOWER.nozzle.rows * ORIGINAL_AIR_SHOWER.nozzle.columns * 2);
        expectPoint(nozzles[0].position, [-halfWidth + wallThickness, 0.85, -config.depth * 0.35]);
        expect(nozzles[0].rotation.z).toBeCloseTo(-Math.PI / 2);
        expect(nozzles[9].rotation.z).toBeCloseTo(Math.PI / 2);

        const doorWidth = config.width - ORIGINAL_AIR_SHOWER.doorWidthInset;
        const doorHeight = config.height - ORIGINAL_AIR_SHOWER.doorHeightInset;
        [-halfDepth, halfDepth].forEach((zPosition, doorIndex) => {
          const door = mesh(scene, chamberName + '-door-' + doorIndex);
          expectPoint(door.position, [0, doorHeight / 2, zPosition]);
          expect(door.getChildMeshes()).toHaveLength(1);
          const windowMesh = mesh(scene, chamberName + '-door-' + doorIndex + '-window');
          expect(windowMesh.parent).toBe(door);
          expectPoint(windowMesh.scaling, [1, 1, 1]);
          const indicator = mesh(scene, chamberName + '-indicator-' + doorIndex);
          expectPoint(indicator.position, [0, doorHeight + ORIGINAL_AIR_SHOWER.indicator.yInset, zPosition]);
          expect(indicator.position.x).toBeCloseTo(0);
          expect(mesh(scene, chamberName + '-indicator-' + doorIndex).name).toBe(chamberName + '-indicator-' + doorIndex);
        });
        expect(doorWidth).toBeCloseTo(config.width - 0.7);

        const hmi = mesh(scene, chamberName + '-hmi');
        expectPoint(hmi.position, [halfWidth - ORIGINAL_AIR_SHOWER.hmi.xInset, 1.5, halfDepth + ORIGINAL_AIR_SHOWER.hmi.zInset]);
        const screen = mesh(scene, chamberName + '-hmi-screen');
        expect(screen.parent).toBe(hmi);
        expect(screen.rotation.y).toBeCloseTo(Math.PI);

        const jets = meshesWithPrefix(scene, chamberName + '-jet-');
        expect(jets).toHaveLength(4);
        expectPoint(jets[0].position, [-ORIGINAL_AIR_SHOWER.jet.x, config.height - ORIGINAL_AIR_SHOWER.jet.yOffset, -config.depth * 0.25]);
        expectPoint(jets[3].position, [ORIGINAL_AIR_SHOWER.jet.x, config.height - ORIGINAL_AIR_SHOWER.jet.yOffset, config.depth * 0.25]);
        expect(jets[0].rotation.x).toBeCloseTo(Math.PI);
        expect(jets[0].material?.name).toBe(chamberName + '-jet-0-material');

        const light = scene.getLightByName(chamberName + '-light') as PointLight;
        expect(light).toBeInstanceOf(PointLight);
        expect(light.parent).toBe(controller.airShowers[index]);
        expectPoint(light.position, [0, config.height - ORIGINAL_AIR_SHOWER.innerLight.yOffset, 0]);
        expect(light.range).toBeCloseTo(ORIGINAL_AIR_SHOWER.innerLight.range, 10);
        expect(light.intensity).toBeCloseTo(ORIGINAL_AIR_SHOWER.innerLight.intensity, 10);

        const billboard = mesh(scene, chamberName + '-billboard');
        expectPoint(billboard.position, [0, config.height + ORIGINAL_AIR_SHOWER.sprite.yOffset, 0]);
        expect(billboard.billboardMode).toBe(7);
        const billboardBounds = billboard.getBoundingInfo().boundingBox;
        expect(billboardBounds.extendSize.x * 2).toBeCloseTo(ORIGINAL_AIR_SHOWER.sprite.width);
        expect(billboardBounds.extendSize.y * 2).toBeCloseTo(ORIGINAL_AIR_SHOWER.sprite.height);
        expect((billboard.metadata as { isAmber: boolean }).isAmber).toBe(config.isAmber);
      });
    } finally {
      closeFacility(fixture);
    }
  });

  it('ports the six royal-blue tacky mats with their aluminium frames', () => {
    const fixture = createFacility();
    try {
      const { scene } = fixture;
      expect(ORIGINAL_STICKY_MATS).toHaveLength(ORIGINAL_FACILITY_COUNTS.stickyMats);
      ORIGINAL_STICKY_MATS.forEach((config, index) => {
        const matName = 'original-sticky-mat-' + index;
        const group = scene.getTransformNodeByName(matName);
        if (!group) {
          throw new Error('missing sticky mat: ' + matName);
        }
        expectPoint(group.position, [config.x, 0, config.z]);
        expect(group.getChildMeshes()).toHaveLength(4);

        const frame = mesh(scene, matName + '-frame');
        expectPoint(frame.position, [0, ORIGINAL_STICKY_MAT.frameThickness / 2, 0]);
        expect(frame.receiveShadows).toBe(true);
        const frameBounds = worldBounds(frame);
        expectPoint(frameBounds.minimumWorld, [
          config.x - (config.width + ORIGINAL_STICKY_MAT.frameBorder * 2) / 2, 0,
          config.z - (config.length + ORIGINAL_STICKY_MAT.frameBorder * 2) / 2,
        ]);
        expectPoint(frameBounds.maximumWorld, [
          config.x + (config.width + ORIGINAL_STICKY_MAT.frameBorder * 2) / 2, ORIGINAL_STICKY_MAT.frameThickness,
          config.z + (config.length + ORIGINAL_STICKY_MAT.frameBorder * 2) / 2,
        ]);

        const surface = mesh(scene, matName + '-surface');
        expectPoint(surface.position, [0, ORIGINAL_STICKY_MAT.frameThickness + ORIGINAL_STICKY_MAT.matOffset, 0]);
        expect(surface.rotation.x).toBeCloseTo(Math.PI / 2);
        expect(surface.receiveShadows).toBe(true);
        expect(mesh(scene, matName + '-tab').rotation.x).toBeCloseTo(Math.PI / 2);
        expect(mesh(scene, matName + '-mark').rotation.x).toBeCloseTo(Math.PI / 2);
        expect(mesh(scene, matName + '-mark').material?.name).toBe(matName + '-mark-material');
      });
    } finally {
      closeFacility(fixture);
    }
  });

  it('ports the full FFU ceiling grid, LED aisles, safety trusses and cable trays', () => {
    const fixture = createFacility();
    try {
      const { scene, controller } = fixture;
      expect(controller.ceilingGroup.name).toBe(CEILING_FFU_GROUP_NAME);
      expect(controller.ceilingGroup.isEnabled()).toBe(false);

      const deck = mesh(scene, 'original-ceiling-deck');
      expect(deck.rotation.x).toBeCloseTo(-Math.PI / 2);
      const deckBounds = worldBounds(deck);
      expectPoint(deckBounds.minimumWorld,
        [ORIGINAL_CEILING_FFU.deck.x - ORIGINAL_CEILING_FFU.deck.width / 2, ORIGINAL_CEILING_FFU.deck.y, ORIGINAL_CEILING_FFU.deck.z - ORIGINAL_CEILING_FFU.deck.depth / 2]);
      expectPoint(deckBounds.maximumWorld,
        [ORIGINAL_CEILING_FFU.deck.x + ORIGINAL_CEILING_FFU.deck.width / 2, ORIGINAL_CEILING_FFU.deck.y, ORIGINAL_CEILING_FFU.deck.z + ORIGINAL_CEILING_FFU.deck.depth / 2]);
      expect(deck.material?.name).toBe('original-ceiling-deck-material');

      expect(ORIGINAL_FFU_GRID.x).toHaveLength(33);
      expect(ORIGINAL_FFU_GRID.z).toHaveLength(42);
      expect(ORIGINAL_FACILITY_COUNTS.ffuUnits).toBe(1386);
      const ffuUnits = meshesWithPrefix(scene, 'original-ffu-');
      expect(ffuUnits).toHaveLength(1386);
      const firstUnit = mesh(scene, 'original-ffu-0-0');
      expectPoint(firstUnit.position, [ORIGINAL_FFU_GRID.x[0], ORIGINAL_CEILING_FFU.unit.y, ORIGINAL_FFU_GRID.z[0]]);
      const lastUnit = mesh(scene, 'original-ffu-32-41');
      expectPoint(lastUnit.position, [ORIGINAL_FFU_GRID.x[32], ORIGINAL_CEILING_FFU.unit.y, ORIGINAL_FFU_GRID.z[41]]);
      expect(firstUnit.material?.name).toBe('original-ffu-unit-material');
      expect(firstUnit.material).toBe(lastUnit.material);
      expect(firstUnit.isPickable).toBe(false);

      const fixtures = meshesWithPrefix(scene, 'original-ceiling-light-fixture-');
      const lenses = meshesWithPrefix(scene, 'original-ceiling-light-lens-');
      expect(fixtures).toHaveLength(ORIGINAL_FACILITY_COUNTS.lightAisles);
      expect(lenses).toHaveLength(ORIGINAL_FACILITY_COUNTS.lightAisles);
      ORIGINAL_CEILING_FFU.lightAislesX.forEach((xPosition, index) => {
        expectPoint(fixtures[index].position, [xPosition, ORIGINAL_CEILING_FFU.lightFixture.y, 0]);
        expectPoint(lenses[index].position, [xPosition, ORIGINAL_CEILING_FFU.lightLens.y, 0]);
        const isLitho = xPosition <= ORIGINAL_CEILING_FFU.lithoAisleMaxX;
        expect(lenses[index].material?.name).toBe('original-ceiling-light-lens-' + index + '-material');
        const lensMaterial = lenses[index].material as PBRMaterial;
        expect(lensMaterial.emissiveIntensity).toBeCloseTo(isLitho ? 1.0 : 1.25, 10);
      });

      expect(meshesWithPrefix(scene, 'original-ceiling-truss-')).toHaveLength(ORIGINAL_FACILITY_COUNTS.trusses);
      const braces = meshesWithPrefix(scene, 'original-ceiling-brace-');
      expect(braces).toHaveLength(ORIGINAL_FACILITY_COUNTS.braces);
      expect(meshesWithPrefix(scene, 'original-ceiling-drop-rod-')).toHaveLength(ORIGINAL_FACILITY_COUNTS.dropRods);
      expect(meshesWithPrefix(scene, 'original-cable-tray-')).toHaveLength(ORIGINAL_FACILITY_COUNTS.cableTrays);
      expect(meshesWithPrefix(scene, 'original-ceiling-cable-')).toHaveLength(ORIGINAL_FACILITY_COUNTS.cableTrays);

      const truss = mesh(scene, 'original-ceiling-truss-0');
      expectPoint(truss.position, [ORIGINAL_CEILING_FFU.truss.x, ORIGINAL_CEILING_FFU.truss.y, ORIGINAL_FFU_GRID.trussZ[0]]);
      const braceOne = mesh(scene, 'original-ceiling-brace-0-0-1');
      expect(braceOne.rotation.x).toBeCloseTo(ORIGINAL_CEILING_FFU.brace.angle);
      expectPoint(braceOne.position, [ORIGINAL_FFU_GRID.braceX[0], ORIGINAL_CEILING_FFU.brace.y, ORIGINAL_FFU_GRID.trussZ[0] - ORIGINAL_CEILING_FFU.brace.zOffset]);
      const braceTwo = mesh(scene, 'original-ceiling-brace-0-0-2');
      expect(braceTwo.rotation.x).toBeCloseTo(-ORIGINAL_CEILING_FFU.brace.angle);
      const rod = mesh(scene, 'original-ceiling-drop-rod-0-0');
      expectPoint(rod.position, [ORIGINAL_FFU_GRID.braceX[0], ORIGINAL_CEILING_FFU.dropRod.y, ORIGINAL_FFU_GRID.trussZ[0]]);
      expect(rod.getBoundingInfo().boundingBox.extendSize.y * 2).toBeCloseTo(ORIGINAL_CEILING_FFU.dropRod.height, 3);
      const cable = mesh(scene, 'original-ceiling-cable-1');
      expect(cable.rotation.x).toBeCloseTo(Math.PI / 2);
      expectPoint(cable.position, [ORIGINAL_CEILING_FFU.cableTray.aislesX[1], ORIGINAL_CEILING_FFU.cable.y, 0]);

      const ceilingMeshes = controller.ceilingGroup.getChildMeshes();
      expect(ceilingMeshes).toHaveLength(1 + 1386 + 8 + 8 + 10 + 100 + 50 + 3 + 3);
      expect(ceilingMeshes.every(candidate => candidate.isPickable === false)).toBe(true);
    } finally {
      closeFacility(fixture);
    }
  });

  it('keeps airlock/tacky-mat visibility on by default and the source ceiling layer off', () => {
    const fixture = createFacility();
    try {
      const { scene, controller } = fixture;
      expect(controller.group.isEnabled()).toBe(true);
      expect(controller.ceilingGroup.isEnabled()).toBe(false);
      expect(mesh(scene, 'original-airshower-main-billboard').isEnabled()).toBe(true);
      expect(mesh(scene, 'original-ffu-0-0').isEnabled()).toBe(false);

      controller.setCeilingVisible(true);
      expect(controller.ceilingGroup.isEnabled()).toBe(true);
      expect(mesh(scene, 'original-ffu-0-0').isEnabled()).toBe(true);

      controller.setVisible(false);
      expect(controller.group.isEnabled()).toBe(false);
      expect(mesh(scene, 'original-airshower-main-billboard').isEnabled()).toBe(false);
      expect(mesh(scene, 'original-ffu-0-0').isEnabled()).toBe(false);
      expect((scene.getLightByName('original-airshower-main-light') as PointLight).isEnabled()).toBe(false);

      controller.setVisible(true);
      expect(controller.group.isEnabled()).toBe(true);
      expect(mesh(scene, 'original-airshower-main-billboard').isEnabled()).toBe(true);
      expect((scene.getLightByName('original-airshower-litho-light') as PointLight).isEnabled()).toBe(true);
      // The independent ceiling sub-layer keeps its own state across the master switch.
      expect(controller.ceilingGroup.isEnabled()).toBe(true);

      controller.setCeilingVisible(false);
      expect(mesh(scene, 'original-ffu-0-0').isEnabled()).toBe(false);
      expect(mesh(scene, 'original-airshower-main-plenum-left').isEnabled()).toBe(true);
    } finally {
      closeFacility(fixture);
    }
  });

  it('switches the two holographic billboards between Chinese and English', () => {
    const fixture = createFacility();
    try {
      const { scene, controller } = fixture;
      const billboards = ORIGINAL_AIR_SHOWERS.map(config => mesh(scene, 'original-airshower-' + config.id + '-billboard'));
      billboards.forEach((billboard, index) => {
        const config = ORIGINAL_AIR_SHOWERS[index];
        expect(billboard.metadata).toMatchObject({ labelKind: 'airshower-billboard', isAmber: config.isAmber, language: 'zh' });
        // NullEngine/Node has no 2D canvas, so only the fallback pill material exists.
        expect((billboard.material as PBRMaterial).albedoTexture).toBeFalsy();
      });
      controller.setLanguage('en');
      expect(billboards.map(candidate => (candidate.metadata as { language: string }).language)).toEqual(['en', 'en']);
      controller.setLanguage('zh');
      expect(billboards.map(candidate => (candidate.metadata as { language: string }).language)).toEqual(['zh', 'zh']);
    } finally {
      closeFacility(fixture);
    }
  });

  it('animates the staggered air shower purge cycle and billboard bob from absolute time', () => {
    const fixture = createFacility();
    try {
      const { scene, controller } = fixture;
      const chamberNames = ORIGINAL_AIR_SHOWERS.map(config => 'original-airshower-' + config.id);
      const labelY = (chamberName: string, timeMs: number, x: number) => {
        controller.update(timeMs);
        return mesh(scene, chamberName + '-billboard').position.y;
      };
      // Source formula: (height + 1.2) + sin(nowSec * 2.2 + ash.position.x) * 0.08.
      ORIGINAL_AIR_SHOWERS.forEach((config, index) => {
        const expectedAtZero = config.height + ORIGINAL_AIR_SHOWER.sprite.yOffset + Math.sin(0 * 2.2 + config.x) * 0.08;
        expect(labelY(chamberNames[index], 0, config.x)).toBeCloseTo(expectedAtZero, 10);
        const expectedAtSecond = config.height + ORIGINAL_AIR_SHOWER.sprite.yOffset + Math.sin(1 * 2.2 + config.x) * 0.08;
        expect(labelY(chamberNames[index], 1000, config.x)).toBeCloseTo(expectedAtSecond, 10);
      });

      const blowingSeen = [false, false];
      const standbySeen = [false, false];
      const allowedIndicatorColors = [0x10b981, 0xf59e0b, 0x0284c7, 0x78350f, 0x0f172a];
      for (let step = 0; step <= 140; step++) {
        controller.update(step * 100);
        ORIGINAL_AIR_SHOWERS.forEach((config, index) => {
          const chamberName = chamberNames[index];
          const indicators = [0, 1].map(door => mesh(scene, chamberName + '-indicator-' + door).material as PBRMaterial);
          const jets = [0, 1, 2, 3].map(jet => mesh(scene, chamberName + '-jet-' + jet).material as PBRMaterial);
          const light = scene.getLightByName(chamberName + '-light') as PointLight;
          const intensity = indicators[0].emissiveIntensity;
          if (intensity === 0.8) {
            standbySeen[index] = true;
            expect(indicators[0].albedoColor.r).toBeCloseTo(0x10 / 255, 10);
            expect(indicators[0].albedoColor.g).toBeCloseTo(0xb9 / 255, 10);
            expect(indicators[1].emissiveIntensity).toBe(0.8);
            for (const jet of jets) {
              expect(jet.alpha).toBe(0);
            }
            expect(light.intensity).toBeCloseTo(0.35, 10);
          } else {
            blowingSeen[index] = true;
            expect([0.2, 1.6]).toContain(intensity);
            expect(indicators[1].emissiveIntensity).toBe(intensity);
            for (const jet of jets) {
              expect(jet.alpha).toBeGreaterThanOrEqual(0.3 - 1e-9);
              expect(jet.alpha).toBeLessThanOrEqual(0.8 + 1e-9);
            }
            expect(light.intensity).toBeGreaterThanOrEqual(0.9 - 1e-9);
            expect(light.intensity).toBeLessThanOrEqual(1.9 + 1e-9);
          }
          for (const indicator of indicators) {
            const color = [indicator.albedoColor.r, indicator.albedoColor.g, indicator.albedoColor.b];
            expect(allowedIndicatorColors.some(candidate =>
              Math.abs((candidate >> 16 & 255) / 255 - color[0]) < 1e-9 &&
              Math.abs((candidate >> 8 & 255) / 255 - color[1]) < 1e-9 &&
              Math.abs((candidate & 255) / 255 - color[2]) < 1e-9)).toBe(true);
          }
        });
      }
      // A full 12 s stagger cycle must expose both the standby and blowing phases.
      expect(standbySeen).toEqual([true, true]);
      expect(blowingSeen).toEqual([true, true]);
    } finally {
      closeFacility(fixture);
    }
  });
});

interface RecordedCall {
  op: string;
  args: readonly (number | string)[];
  fillStyle: string;
  strokeStyle: string;
  font: string;
  lineWidth: number;
  textAlign: string;
}

function recordingContext() {
  const state = { fillStyle: '', strokeStyle: '', font: '', lineWidth: 0, textAlign: '', textBaseline: '' };
  const calls: RecordedCall[] = [];
  const record = (op: string, args: readonly (number | string)[]) => {
    calls.push({ op, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, font: state.font, lineWidth: state.lineWidth, textAlign: state.textAlign });
  };
  const context = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value: string) { state.fillStyle = value; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(value: string) { state.strokeStyle = value; },
    get font() { return state.font; },
    set font(value: string) { state.font = value; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(value: number) { state.lineWidth = value; },
    get textAlign() { return state.textAlign; },
    set textAlign(value: string) { state.textAlign = value; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(value: string) { state.textBaseline = value; },
    clearRect: (x: number, y: number, width: number, height: number) => record('clearRect', [x, y, width, height]),
    fillRect: (x: number, y: number, width: number, height: number) => record('fillRect', [x, y, width, height]),
    strokeRect: (x: number, y: number, width: number, height: number) => record('strokeRect', [x, y, width, height]),
    beginPath: () => record('beginPath', []),
    roundRect: (x: number, y: number, width: number, height: number, radii: number) => record('roundRect', [x, y, width, height, radii]),
    fill: () => record('fill', []),
    stroke: () => record('stroke', []),
    fillText: (text: string, x: number, y: number) => record('fillText', [text, x, y]),
  };
  return { context: context as unknown as FacilityCanvasContext, calls };
}

describe('original air shower billboard canvas recipe', () => {
  it('draws the 512 x 192 holographic card in both languages', () => {
    const cases = [
      { isAmber: false, language: 'en' as const, badge: '● AIRLOCK', title: 'MAIN AIR SHOWER TUNNEL', sub: 'ISO Class 1 Entry · 28 m/s Jets', background: 'rgba(15, 23, 42, 0.94)', border: '#38bdf8', badgeFill: '#0284c7', status: '#34d399' },
      { isAmber: true, language: 'zh' as const, badge: '● UV-SAFE', title: '黄光抗紫外风淋气闸', sub: '589nm 防紫外 · ISO-1 洁净气闸', background: 'rgba(24, 16, 8, 0.94)', border: '#f59e0b', badgeFill: '#d97706', status: '#fbbf24' },
    ];
    for (const testCase of cases) {
      const { context, calls } = recordingContext();
      drawOriginalAirShowerBillboard(context, testCase.isAmber, testCase.language);
      expect(calls[0].op).toBe('clearRect');
      expect(calls[0].args).toEqual([0, 0, AIR_SHOWER_SPRITE_CANVAS.width, AIR_SHOWER_SPRITE_CANVAS.height]);

      const rounded = calls.filter(call => call.op === 'roundRect');
      expect(rounded.map(call => call.args)).toEqual([[8, 8, 496, 176, 20], [8, 8, 496, 176, 20], [24, 22, 154, 34, 12]]);
      const fills = calls.filter(call => call.op === 'fill');
      expect(fills[0].fillStyle).toBe(testCase.background);
      expect(fills[1].fillStyle).toBe(testCase.badgeFill);
      const strokes = calls.filter(call => call.op === 'stroke');
      expect(strokes).toHaveLength(1);
      expect(strokes[0].strokeStyle).toBe(testCase.border);
      expect(strokes[0].lineWidth).toBe(4.5);

      const texts = calls.filter(call => call.op === 'fillText');
      expect(texts).toHaveLength(4);
      expect(texts[0].args).toEqual([testCase.badge, 101, 39]);
      expect(texts[0].fillStyle).toBe('#ffffff');
      expect(texts[0].textAlign).toBe('center');
      expect(texts[1].args).toEqual(['READY · 28 m/s', 480, 39]);
      expect(texts[1].fillStyle).toBe(testCase.status);
      expect(texts[1].textAlign).toBe('right');
      expect(texts[2].args).toEqual([testCase.title, 26, 96]);
      expect(texts[2].fillStyle).toBe(testCase.isAmber ? '#fef08a' : '#f0f9ff');
      expect(texts[2].textAlign).toBe('left');
      expect(texts[3].args).toEqual([testCase.sub, 26, 140]);
      expect(texts[3].fillStyle).toBe('#94a3b8');
    }
  });

  it('builds the canvas textures when a 2D canvas is available and redraws on setLanguage', () => {
    const engine = new NullEngine();
    Object.defineProperty(engine, 'isWebGPU', { value: true });
    const scene = new Scene(engine);
    const root = new TransformNode('facility-canvas-root', scene);
    const canvases: Array<{ width: number; height: number; getContext: () => unknown }> = [];
    const drawnTexts: string[][] = [];
    vi.stubGlobal('document', {
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => {
        const texts: string[] = [];
        drawnTexts.push(texts);
        const context = {
          fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
          clearRect: () => {},
          fillRect: () => {},
          strokeRect: () => {},
          beginPath: () => {},
          roundRect: () => {},
          fill: () => {},
          stroke: () => {},
          fillText: (text: string) => texts.push(text),
        };
        const canvas = { width: 0, height: 0, getContext: () => context };
        canvases.push(canvas);
        return canvas;
      },
    });
    try {
      const controller = buildOriginalFacilityArchitecture(scene, root);
      expect(canvases).toHaveLength(ORIGINAL_AIR_SHOWERS.length);
      ORIGINAL_AIR_SHOWERS.forEach((config, index) => {
        const billboard = mesh(scene, 'original-airshower-' + config.id + '-billboard');
        const material = billboard.material as PBRMaterial;
        expect(material.albedoTexture?.name).toBe('original-airshower-' + config.id + '-billboard-texture');
        expect(material.albedoColor.r).toBeCloseTo(1);
        // Initial language is 'zh', the TwinLocale default.
        expect(drawnTexts[index]).toEqual(config.isAmber
          ? ['● UV-SAFE', 'READY · 28 m/s', '黄光抗紫外风淋气闸', '589nm 防紫外 · ISO-1 洁净气闸']
          : ['● AIRLOCK', 'READY · 28 m/s', '主人员洁净风淋气闸', 'ISO Class 1 入口 · 28 m/s 高速吹淋']);
      });
      controller.setLanguage('en');
      expect(drawnTexts[0].slice(-4)).toEqual(['● AIRLOCK', 'READY · 28 m/s', 'MAIN AIR SHOWER TUNNEL', 'ISO Class 1 Entry · 28 m/s Jets']);
      expect(drawnTexts[1].slice(-4)).toEqual(['● UV-SAFE', 'READY · 28 m/s', 'LITHO AMBER AIRLOCK', '589nm UV-Safe · Esco/Terra ISO-1']);
      controller.setLanguage('zh');
      expect(drawnTexts[0].slice(-1)).toEqual(['ISO Class 1 入口 · 28 m/s 高速吹淋']);
    } finally {
      scene.dispose();
      engine.dispose();
      vi.unstubAllGlobals();
    }
  });
});
