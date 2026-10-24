import { describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import {
  buildOriginalRoofHvac,
  drawOriginalRoofSprite,
  ORIGINAL_ROOF_BAY_DROPS,
  ORIGINAL_ROOF_CHIMNEYS,
  ORIGINAL_ROOF_EXHAUST,
  ORIGINAL_ROOF_MAU,
  ORIGINAL_ROOF_MAUS,
  ORIGINAL_ROOF_PARAPETS,
  ORIGINAL_ROOF_SLAB,
  ORIGINAL_ROOF_SUPPLY_MAINS,
  ROOF_EXHAUST_PARTICLES_PER_STACK,
  ROOF_EXHAUST_PARTICLE_COUNT,
  ROOF_HVAC_GROUP_NAME,
  ROOF_SPRITE_CANVAS,
  ROOF_SPRITE_FONT_BODY,
  ROOF_SPRITE_FONT_TITLE,
  type OriginalRoofHvacController,
  type RoofSpriteRenderingContext,
} from '../src/original-roof-hvac';

interface RoofFixture {
  engine: NullEngine;
  scene: Scene;
  root: TransformNode;
  controller: OriginalRoofHvacController;
}

// CPU geometry inspection only. The product renders with WebGPU, so select the
// WGSL material-plugin language; NullEngine neither compiles shaders nor counts
// as GPU acceptance.
function createRoof(): RoofFixture {
  const engine = new NullEngine();
  Object.defineProperty(engine, 'isWebGPU', { value: true });
  const scene = new Scene(engine);
  const root = new TransformNode('roof-hvac-test-root', scene);
  return { engine, scene, root, controller: buildOriginalRoofHvac(scene, root) };
}

function closeRoof(fixture: RoofFixture): void {
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

function particleMeshes(controller: OriginalRoofHvacController): Mesh[] {
  return controller.group.getChildMeshes()
    .filter(child => child.name.startsWith('original-roof-exhaust-particle-'))
    .map(child => child as Mesh)
    .sort((left, right) => Number(left.name.slice(left.name.lastIndexOf('-') + 1)) - Number(right.name.slice(right.name.lastIndexOf('-') + 1)));
}

// Literal r128 MeshStandardMaterial palette from buildRoofHVACLayer.
const EXPECTED_MATERIALS: ReadonlyArray<readonly [string, number, number, number]> = [
  ['original-roof-slab-material', 0xcfd4dc, 0.2, 0.65],
  ['original-roof-parapet-material', 0x94a3b8, 0.2, 0.7],
  ['original-roof-mau-enclosure-material', 0x94a3b8, 0.55, 0.35],
  ['original-roof-mau-louver-material', 0x334155, 0.4, 0.7],
  ['original-roof-mau-fan-material', 0x475569, 0.6, 0.3],
  ['original-roof-supply-duct-material', 0x7db8e8, 0.3, 0.35],
  ['original-roof-exhaust-material', 0xe8935a, 0.3, 0.35],
];

describe('original roof and exterior HVAC port', () => {
  it('maps the original r128 standard palette onto legacy-light PBR materials', () => {
    const fixture = createRoof();
    try {
      for (const [name, color, metalness, roughness] of EXPECTED_MATERIALS) {
        const material = materialOf(fixture.scene, name);
        const channels = material.albedoColor.asArray();
        expect(channels[0]).toBeCloseTo((color >> 16 & 255) / 255, 10);
        expect(channels[1]).toBeCloseTo((color >> 8 & 255) / 255, 10);
        expect(channels[2]).toBeCloseTo((color & 255) / 255, 10);
        expect(material.metallic).toBeCloseTo(metalness, 10);
        expect(material.roughness).toBeCloseTo(roughness, 10);
        expect(material.usePhysicalLightFalloff).toBe(false);
        expect(material.pluginManager?.getPlugin('OriginalLegacyLightFalloff')).toBeDefined();
      }
      const particle = materialOf(fixture.scene, 'original-roof-exhaust-particle-material');
      expect(particle.unlit).toBe(true);
      expect(particle.alpha).toBeCloseTo(ORIGINAL_ROOF_EXHAUST.particleOpacity, 10);
      expect(particle.albedoColor.r).toBeCloseTo(254 / 255, 10);
      expect(particle.albedoColor.g).toBeCloseTo(215 / 255, 10);
      expect(particle.albedoColor.b).toBeCloseTo(170 / 255, 10);
      expect(particle.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHABLEND);
      // Source exhaust particles are unlit THREE.PointsMaterial, not legacy PBR.
      expect(particle.pluginManager?.getPlugin('OriginalLegacyLightFalloff')).toBeFalsy();
    } finally {
      closeRoof(fixture);
    }
  });

  it('ports the 85 x 60 m roof slab, four parapets and three MAU units', () => {
    const fixture = createRoof();
    try {
      const { scene, controller } = fixture;
      expect(controller.group.name).toBe(ROOF_HVAC_GROUP_NAME);
      expect(controller.group.parent).toBe(fixture.root);
      // Source line 16020: roofGroup.visible = false until toggleRoofVisibility(true).
      expect(controller.group.isEnabled()).toBe(false);

      const slab = mesh(scene, 'original-roof-slab');
      const slabBounds = worldBounds(slab);
      expectPoint(slabBounds.minimumWorld, [-38, 7.85, -29]);
      expectPoint(slabBounds.maximumWorld, [47, 8.15, 31]);
      expect(slab.receiveShadows).toBe(true);
      expect(slab.material?.name).toBe('original-roof-slab-material');

      const parapets = ORIGINAL_ROOF_PARAPETS.map(parapet => mesh(scene, 'original-roof-parapet-' + parapet.id));
      expect(parapets).toHaveLength(4);
      const north = worldBounds(parapets[0]);
      expectPoint(north.minimumWorld, [-38, 8.125, -29.15]);
      expectPoint(north.maximumWorld, [47, 8.575, -28.85]);
      const west = worldBounds(parapets[2]);
      expectPoint(west.minimumWorld, [-38.15, 8.125, -29]);
      expectPoint(west.maximumWorld, [-37.85, 8.575, 31]);
      expect(parapets[1].material).toBe(parapets[0].material);

      for (const mau of ORIGINAL_ROOF_MAUS) {
        const id = mau.id.toLowerCase();
        const mauGroup = scene.getTransformNodeByName('original-roof-' + id);
        if (!mauGroup) {
          throw new Error('missing MAU group: ' + id);
        }
        mauGroup.computeWorldMatrix(true);
        expectPoint(mauGroup.getAbsolutePosition(), [mau.x, ORIGINAL_ROOF_MAU.groupY, mau.z]);

        const body = mesh(scene, 'original-roof-' + id + '-body');
        const bodyBounds = worldBounds(body);
        expectPoint(bodyBounds.minimumWorld, [mau.x - 3, 8.15, -22]);
        expectPoint(bodyBounds.maximumWorld, [mau.x + 3, 11.15, -18]);
        expect(body.receiveShadows).toBe(true);
        expect(body.material?.name).toBe('original-roof-mau-enclosure-material');

        const louver = mesh(scene, 'original-roof-' + id + '-louver');
        expect(louver.position.z).toBeCloseTo(ORIGINAL_ROOF_MAU.louver.z);
        expect(louver.rotation.y).toBeCloseTo(Math.PI);
        const louverBounds = louver.getBoundingInfo().boundingBox;
        expect(louverBounds.extendSize.x * 2).toBeCloseTo(ORIGINAL_ROOF_MAU.louver.width);
        expect(louverBounds.extendSize.y * 2).toBeCloseTo(ORIGINAL_ROOF_MAU.louver.height);
        expect(louver.material?.name).toBe('original-roof-mau-louver-material');

        for (const [index, localX] of [-ORIGINAL_ROOF_MAU.fanCowl.localX, ORIGINAL_ROOF_MAU.fanCowl.localX].entries()) {
          const cowl = mesh(scene, 'original-roof-' + id + '-cowl-' + (index + 1));
          cowl.computeWorldMatrix(true);
          expectPoint(cowl.getAbsolutePosition(), [mau.x + localX, 11.4, -20]);
          const cowlBounds = worldBounds(cowl);
          expectPoint(cowlBounds.minimumWorld, [mau.x + localX - 0.7, 11.15, -20.7]);
          expectPoint(cowlBounds.maximumWorld, [mau.x + localX + 0.7, 11.65, -19.3]);
          expect(cowl.material?.name).toBe('original-roof-mau-fan-material');
        }

        const curb = mesh(scene, 'original-roof-' + id + '-curb');
        const curbBounds = worldBounds(curb);
        expectPoint(curbBounds.minimumWorld, [mau.x - 3.2, 8.15, -22.2]);
        expectPoint(curbBounds.maximumWorld, [mau.x + 3.2, 8.35, -17.8]);
        expect(curb.material).toBe(parapets[0].material);
      }
    } finally {
      closeRoof(fixture);
    }
  });

  it('reproduces the three supply mains, three MAU feeders and twelve branch drops', () => {
    const fixture = createRoof();
    try {
      const { scene, controller } = fixture;
      const mains = ORIGINAL_ROOF_SUPPLY_MAINS.map(main => mesh(scene, 'original-roof-supply-main-' + main.line));
      expect(mains).toHaveLength(3);
      ORIGINAL_ROOF_SUPPLY_MAINS.forEach((main, index) => {
        const bounds = worldBounds(mains[index]);
        expectPoint(bounds.minimumWorld, [-36, 8.25, main.z - 0.6]);
        expectPoint(bounds.maximumWorld, [45, 9.05, main.z + 0.6]);
      });
      expect(mains[0].material).toBe(mains[1].material);
      expect(mains[0].metadata).toEqual({
        isDuct: true,
        tooltipEn: 'Supply Air Main (North Line) → Lithography, Etch & Thin Film Bays',
        tooltipZh: '送风主管 (北干线) → 光刻/刻蚀/薄膜核心工艺区',
      });

      for (const mau of ORIGINAL_ROOF_MAUS) {
        const feeder = worldBounds(mesh(scene, 'original-roof-supply-feeder-' + mau.id.toLowerCase()));
        expectPoint(feeder.minimumWorld, [mau.x - 0.45, 8.3, -20]);
        expectPoint(feeder.maximumWorld, [mau.x + 0.45, 9, 15]);
      }

      const drops = ORIGINAL_ROOF_BAY_DROPS.map((branch, index) => mesh(scene, 'original-roof-supply-drop-' + index));
      expect(drops).toHaveLength(12);
      ORIGINAL_ROOF_BAY_DROPS.forEach((branch, index) => {
        const bounds = worldBounds(drops[index]);
        expectPoint(bounds.minimumWorld, [branch.x - 0.375, 5.22, branch.z - 0.375]);
        expectPoint(bounds.maximumWorld, [branch.x + 0.375, 8.65, branch.z + 0.375]);
        expect(drops[index].material).toBe(mains[0].material);
        expect((drops[index].metadata as { isDuct: boolean }).isDuct).toBe(true);
      });
      expect(drops[3].metadata).toEqual({
        isDuct: true,
        tooltipEn: 'Supply air branch → Thin Film Deposition Bay (CVD/PVD)',
        tooltipZh: '送风支管 → 薄膜沉积与外延区',
      });

      const children = controller.group.getChildMeshes();
      const ducts = children.filter(child => (child.metadata as { isDuct?: boolean } | null)?.isDuct === true);
      // Source roofDuctMeshes: 3 MAU bodies + 3 mains + 3 feeders + 12 drops + 5 stacks + 5 cowls.
      expect(ducts).toHaveLength(31);
      expect(children.filter(child => !child.name.startsWith('original-roof-exhaust-particle-'))).toHaveLength(51);
      expect(children).toHaveLength(51 + ROOF_EXHAUST_PARTICLE_COUNT);
    } finally {
      closeRoof(fixture);
    }
  });

  it('builds the five exhaust stacks with their cowls and shared tooltip metadata', () => {
    const fixture = createRoof();
    try {
      const { scene } = fixture;
      ORIGINAL_ROOF_CHIMNEYS.forEach((chimney, index) => {
        const stack = mesh(scene, 'original-roof-exhaust-stack-' + (index + 1));
        const stackBounds = worldBounds(stack);
        expectPoint(stackBounds.minimumWorld, [chimney.x - 0.5, 8.15, chimney.z - 0.5]);
        expectPoint(stackBounds.maximumWorld, [chimney.x + 0.5, 12.15, chimney.z + 0.5]);
        expect(stack.receiveShadows).toBe(false);

        const cowl = mesh(scene, 'original-roof-exhaust-cowl-' + (index + 1));
        const cowlBounds = worldBounds(cowl);
        expectPoint(cowlBounds.minimumWorld, [chimney.x - 0.65, 12.05, chimney.z - 0.65]);
        expectPoint(cowlBounds.maximumWorld, [chimney.x + 0.65, 12.35, chimney.z + 0.65]);
        expect(cowl.material).toBe(stack.material);
        // Source assigns cowl.userData = chMesh.userData (same object).
        expect(cowl.metadata).toBe(stack.metadata);
      });
      expect(mesh(scene, 'original-roof-exhaust-stack-1').metadata).toEqual({
        isDuct: true,
        tooltipEn: 'Exhaust Chimney (Stack #1) → Acid / Corrosive Wet Scrubber Stack',
        tooltipZh: '工艺排气烟囱 (#1) → 酸性腐蚀废气洗涤塔排气烟囱',
      });
      expect(mesh(scene, 'original-roof-exhaust-cowl-1').material?.name).toBe('original-roof-exhaust-material');
    } finally {
      closeRoof(fixture);
    }
  });

  it('ports the 70 exhaust particles and advances them only while the layer is shown', () => {
    const fixture = createRoof();
    try {
      const { controller } = fixture;
      const particles = particleMeshes(controller);
      expect(particles).toHaveLength(ROOF_EXHAUST_PARTICLE_COUNT);
      expect(ROOF_EXHAUST_PARTICLES_PER_STACK * ORIGINAL_ROOF_CHIMNEYS.length).toBe(70);

      const spawn = particles.map(particle => particle.position.clone());
      particles.forEach((particle, index) => {
        const chimney = ORIGINAL_ROOF_CHIMNEYS[Math.floor(index / ROOF_EXHAUST_PARTICLES_PER_STACK)];
        const radial = Math.hypot(particle.position.x - chimney.x, particle.position.z - chimney.z);
        expect(radial).toBeLessThanOrEqual(ORIGINAL_ROOF_EXHAUST.radiusJitter + 1e-9);
        expect(particle.position.y).toBeGreaterThanOrEqual(ORIGINAL_ROOF_EXHAUST.spawnBaseY - 1e-9);
        expect(particle.position.y).toBeLessThan(ORIGINAL_ROOF_EXHAUST.spawnBaseY + ORIGINAL_ROOF_EXHAUST.spawnJitterY + 1e-9);
        expect(particle.billboardMode).toBe(7);
        expect(particle.isPickable).toBe(false);
        expect(particle.material).toBe(particles[0].material);
      });
      const particleMaterial = particles[0].material as PBRMaterial;
      expect(particleMaterial.name).toBe('original-roof-exhaust-particle-material');
      expect(particleMaterial.unlit).toBe(true);
      expect(particleMaterial.alpha).toBeCloseTo(ORIGINAL_ROOF_EXHAUST.particleOpacity, 10);

      // Source updateRoofHVACParticles early-returns while showRoof is false.
      expect(controller.group.isEnabled()).toBe(false);
      expect(particles.every(particle => !particle.isEnabled())).toBe(true);
      controller.update(1000);
      controller.update(1100);
      expect(particles.map(particle => particle.position.y)).toEqual(spawn.map(position => position.y));

      controller.setVisible(true);
      expect(controller.group.isEnabled()).toBe(true);
      expect(particles.every(particle => particle.isEnabled())).toBe(true);
      controller.update(1000);
      expect(particles.map(particle => particle.position.y)).toEqual(spawn.map(position => position.y));
      controller.update(1100);
      for (const [index, particle] of particles.entries()) {
        const dy = particle.position.y - spawn[index].y;
        // Six 60 Hz source frames: speed is 0.015 + random * 0.02 m per frame.
        expect(dy).toBeGreaterThanOrEqual(6 * ORIGINAL_ROOF_EXHAUST.minSpeed - 1e-9);
        expect(dy).toBeLessThanOrEqual(6 * (ORIGINAL_ROOF_EXHAUST.minSpeed + ORIGINAL_ROOF_EXHAUST.speedJitter) + 1e-9);
        expect(particle.position.x).toBe(spawn[index].x);
        expect(particle.position.z).toBe(spawn[index].z);
        expect(particle.position.y).toBeLessThanOrEqual(ORIGINAL_ROOF_EXHAUST.recycleY);
      }
      const advanced = particles.map(particle => particle.position.y);
      controller.update(1100);
      expect(particles.map(particle => particle.position.y)).toEqual(advanced);

      controller.setVisible(false);
      const frozen = particles.map(particle => particle.position.y);
      controller.update(2000);
      controller.update(3000);
      expect(particles.map(particle => particle.position.y)).toEqual(frozen);
    } finally {
      closeRoof(fixture);
    }
  });

  it('builds the three bilingual MAU sprite cards and switches their language', () => {
    const fixture = createRoof();
    try {
      const { scene, controller } = fixture;
      const labels = ORIGINAL_ROOF_MAUS.map(mau => mesh(scene, 'original-roof-' + mau.id.toLowerCase() + '-label'));
      labels.forEach((label, index) => {
        const mau = ORIGINAL_ROOF_MAUS[index];
        expect(label.billboardMode).toBe(7);
        expect(label.position.asArray()).toEqual([0, ORIGINAL_ROOF_MAU.sprite.localY, 0]);
        const local = label.getBoundingInfo().boundingBox;
        expect(local.extendSize.x * 2).toBeCloseTo(ORIGINAL_ROOF_MAU.sprite.width);
        expect(local.extendSize.y * 2).toBeCloseTo(ORIGINAL_ROOF_MAU.sprite.height);
        label.computeWorldMatrix(true);
        expectPoint(label.getAbsolutePosition(), [mau.x, ORIGINAL_ROOF_MAU.groupY + ORIGINAL_ROOF_MAU.sprite.localY, mau.z]);
        expect(label.metadata).toEqual({ labelEn: mau.nameEn, labelZh: mau.nameZh, language: 'zh' });
        const material = label.material as PBRMaterial;
        expect(material.unlit).toBe(true);
        expect(material.backFaceCulling).toBe(false);
        // NullEngine/Node has no 2D canvas, so the canvas texture is not built.
        expect(material.albedoTexture).toBeFalsy();
      });
      controller.setLanguage('en');
      expect(labels.map(label => (label.metadata as { language: string }).language)).toEqual(['en', 'en', 'en']);
      controller.setLanguage('zh');
      expect(labels.map(label => (label.metadata as { language: string }).language)).toEqual(['zh', 'zh', 'zh']);
    } finally {
      closeRoof(fixture);
    }
  });

  it('builds the canvas sprite textures when a 2D canvas is available', () => {
    const engine = new NullEngine();
    Object.defineProperty(engine, 'isWebGPU', { value: true });
    const scene = new Scene(engine);
    const root = new TransformNode('roof-hvac-canvas-root', scene);
    const canvases: Array<{ width: number; height: number; getContext: () => unknown }> = [];
    const drawnTexts: string[][] = [];
    const fakeContext = () => {
      const texts: string[] = [];
      drawnTexts.push(texts);
      return {
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
    };
    vi.stubGlobal('document', {
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => {
        const context = fakeContext();
        const canvas = { width: 0, height: 0, getContext: () => context };
        canvases.push(canvas);
        return canvas;
      },
    });
    try {
      const controller = buildOriginalRoofHvac(scene, root);
      expect(canvases).toHaveLength(ORIGINAL_ROOF_MAUS.length);
      const labels = ORIGINAL_ROOF_MAUS.map(mau => mesh(scene, 'original-roof-' + mau.id.toLowerCase() + '-label'));
      labels.forEach((label, index) => {
        const material = label.material as PBRMaterial;
        expect(material.albedoTexture?.name).toBe('original-roof-' + ORIGINAL_ROOF_MAUS[index].id.toLowerCase() + '-label-texture');
        expect(material.albedoColor.r).toBeCloseTo(1);
        expect(material.albedoColor.g).toBeCloseTo(1);
        expect(material.albedoColor.b).toBeCloseTo(1);
      });
      // Initial TwinLocale default: Chinese body line with the English title tag.
      expect(drawnTexts[0]).toEqual(['MAU-1', 'MAU-1 新风机组']);
      controller.setLanguage('en');
      expect(drawnTexts[0].slice(-2)).toEqual(['MAU-1', 'MAU-1 Make-up Air Unit']);
      controller.setLanguage('zh');
      expect(drawnTexts[0].slice(-2)).toEqual(['MAU-1', 'MAU-1 新风机组']);
    } finally {
      scene.dispose();
      engine.dispose();
      vi.unstubAllGlobals();
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
}

function recordingContext(options: { roundRect: boolean }) {
  const state = { fillStyle: '', strokeStyle: '', font: '', lineWidth: 0, textAlign: '', textBaseline: '' };
  const calls: RecordedCall[] = [];
  const record = (op: string, args: readonly (number | string)[]) => {
    calls.push({ op, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, font: state.font, lineWidth: state.lineWidth });
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
    roundRect: options.roundRect
      ? (x: number, y: number, width: number, height: number, radii: number) => record('roundRect', [x, y, width, height, radii])
      : undefined,
    fill: () => record('fill', []),
    stroke: () => record('stroke', []),
    fillText: (text: string, x: number, y: number) => record('fillText', [text, x, y]),
  };
  return { context: context as unknown as RoofSpriteRenderingContext, calls };
}

describe('original roof sprite canvas recipe', () => {
  it('draws the 384 x 96 rounded bilingual card and switches its body line', () => {
    const cases = [
      ['en', 'MAU-1 Make-up Air Unit'],
      ['zh', 'MAU-1 新风机组'],
    ] as const;
    for (const [language, expectedBody] of cases) {
      const { context, calls } = recordingContext({ roundRect: true });
      drawOriginalRoofSprite(context, 'MAU-1 Make-up Air Unit', 'MAU-1 新风机组', language);

      const clear = calls[0];
      expect(clear.op).toBe('clearRect');
      expect(clear.args).toEqual([0, 0, ROOF_SPRITE_CANVAS.width, ROOF_SPRITE_CANVAS.height]);

      const rounded = calls.filter(call => call.op === 'roundRect');
      expect(rounded).toHaveLength(2);
      expect(rounded[0].args).toEqual([6, 6, 372, 84, 16]);
      expect(rounded[1].args).toEqual([6, 6, 372, 84, 16]);

      const fill = calls.find(call => call.op === 'fill');
      expect(fill?.fillStyle).toBe('rgba(15, 23, 42, 0.90)');
      const stroke = calls.find(call => call.op === 'stroke');
      expect(stroke?.strokeStyle).toBe('rgba(56, 189, 248, 0.75)');
      expect(stroke?.lineWidth).toBe(3);

      const texts = calls.filter(call => call.op === 'fillText');
      expect(texts).toHaveLength(2);
      expect(texts[0].args).toEqual(['MAU-1', 192, 34]);
      expect(texts[0].fillStyle).toBe('#38bdf8');
      expect(texts[0].font).toBe(ROOF_SPRITE_FONT_TITLE);
      expect(texts[1].args).toEqual([expectedBody, 192, 64]);
      expect(texts[1].fillStyle).toBe('#ffffff');
      expect(texts[1].font).toBe(ROOF_SPRITE_FONT_BODY);
    }
  });

  it('keeps the legacy square-card fallback when roundRect is unavailable', () => {
    const { context, calls } = recordingContext({ roundRect: false });
    drawOriginalRoofSprite(context, 'MAU-2 Make-up Air Unit', 'MAU-2 新风机组', 'en');
    expect(calls.some(call => call.op === 'roundRect')).toBe(false);
    expect(calls.some(call => call.op === 'beginPath')).toBe(false);
    expect(calls.find(call => call.op === 'fillRect')?.args).toEqual([6, 6, 372, 84]);
    expect(calls.find(call => call.op === 'strokeRect')?.args).toEqual([6, 6, 372, 84]);
    expect(calls.filter(call => call.op === 'fillText')[0].args).toEqual(['MAU-2', 192, 34]);
  });
});
