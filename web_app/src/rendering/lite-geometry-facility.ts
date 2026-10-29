import {
  addToScene, createBox, createCylinder, createPlane, createPbrMaterial, createPointLight, createTransformNode,
  setParent, setPbrEmissive, setPbrTransmission, setPbrUnlit, setThinInstances, enableThinInstanceWorldBounds,
  setSubtreeVisible, markMaterialUboDirty, onBeforeRender, createShaderMaterial, setShaderUniform, setLightIntensity,
  createDynamicTexture, updateDynamicTexture, releaseTexture, createGridSpriteAtlas,
  createFacingBillboardSystem, addBillboardSprite, updateBillboardSprite,
  type EngineContext, type Mesh, type PbrMaterialProps, type TransformNode, type Material,
  type DynamicTexture2D, type BillboardSpriteHandle, type ShaderMaterial, type SceneContext,
} from '@babylonjs/lite';
import { createOverlayBillboards, type OverlayBillboardSystem } from '@/rendering/lite-overlay-billboards';
import { createPersonnelTimeline, type AirShowerFrame } from '@/domain/personnel-timeline';
import { ORIGINAL_AIR_SHOWERS, ORIGINAL_AIR_SHOWER as air, ORIGINAL_STICKY_MATS, ORIGINAL_STICKY_MAT as mat,
  ORIGINAL_CEILING_FFU as ffu, ORIGINAL_FFU_GRID, drawOriginalAirShowerBillboard, AIR_SHOWER_SPRITE_CANVAS } from '@/rendering/lite-geometry-facility-layout';

type Triple = readonly [number, number, number];
const rgb = (hex: number): [number, number, number] => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map(v => v / 255) as [number, number, number];
export interface FacilityPart { name: string; mesh: Mesh; instanceIndex: number }

/** Native port of original-facility-architecture.ts. All measurements remain source RH metres. */
export function createLiteFacility(scene: SceneContext, engine: EngineContext, options: { frames?: () => readonly AirShowerFrame[] } = {}) {
  const root = createTransformNode('facilityArchitecturalInterfaces');
  const ceiling = createTransformNode('ceilingFFU'); setParent(ceiling, root);
  const parts: FacilityPart[] = [], meshes: Mesh[] = [], airShowers: TransformNode[] = [];
  const lights: ReturnType<typeof createPointLight>[] = [], textures = new Set<DynamicTexture2D>();
  const labels: BillboardSpriteHandle[] = [];
  const chambers: { id: string; group: TransformNode; indicators: PbrMaterialProps[];
    jets: { mesh: Mesh; material: ShaderMaterial; color: [number, number, number] }[];
    light: ReturnType<typeof createPointLight>; label?: BillboardSpriteHandle; labelY: number;
    labelArt?: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; texture: DynamicTexture2D; isAmber: boolean } }[] = [];
  let disposed = false;
  const labelOverlay = createOverlayBillboards(scene, engine);
  labelOverlay.setName('facility-labels');
  const labelSystems: OverlayBillboardSystem[] = [];
  const shaded = (name: string, color: number, metallic = 0, roughness = 1) => {
    const material = createPbrMaterial({ baseColorFactor: [...rgb(color), 1], metallicFactor: metallic,
      roughnessFactor: roughness, directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false });
    material.name = name; return material;
  };
  const emissive = (material: PbrMaterialProps, color: number, intensity: number) => {
    setPbrEmissive(material, rgb(color).map(v => v * intensity) as [number, number, number]); return material;
  };
  function finish(mesh: Mesh, name: string, at: Triple, material: Material, parent: TransformNode) {
    mesh.name = name; mesh.material = material; setParent(mesh, parent); mesh.position.set(...at);
    mesh.metadata = { staticShadowCaster: false }; addToScene(scene, mesh);
    parts.push({ name, mesh, instanceIndex: 0 }); meshes.push(mesh); return mesh;
  }
  const box = (name: string, size: Triple, at: Triple, material: Material, parent = root) =>
    finish(createBox(engine, { width: size[0], height: size[1], depth: size[2] }), name, at, material, parent);
  const cylinder = (name: string, top: number, bottom: number, height: number, segments: number,
    at: Triple, material: Material, parent = root) =>
    finish(createCylinder(engine, { diameterTop: top, diameterBottom: bottom, height, tessellation: segments }), name, at, material, parent);
  const plane = (name: string, size: readonly [number, number], at: Triple, material: Material,
    parent = root, rotationX = 0, rotationY = 0) => {
    const mesh = finish(createPlane(engine, { width: size[0], height: size[1] }), name, at, material, parent);
    mesh.rotation.x = rotationX; mesh.rotation.y = rotationY; return mesh;
  };
  function label(config: typeof ORIGINAL_AIR_SHOWERS[number]) {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = AIR_SHOWER_SPRITE_CANVAS.width; canvas.height = AIR_SHOWER_SPRITE_CANVAS.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Airlock label Canvas2D unavailable');
    drawOriginalAirShowerBillboard(context, config.isAmber, 'zh');
    const texture = createDynamicTexture(engine, canvas.width, canvas.height, { srgb: false, mipMaps: true });
    textures.add(texture); updateDynamicTexture(engine, texture, canvas, { invertY: false });
    const atlas = createGridSpriteAtlas(texture, { cellWidthPx: canvas.width, cellHeightPx: canvas.height });
    const system = createFacingBillboardSystem(atlas, { capacity: 1 });
    const handle = addBillboardSprite(system, { position: [config.x, config.height + air.sprite.yOffset, -config.z],
      sizeWorld: [air.sprite.width, air.sprite.height] });
    labels.push(handle); labelSystems.push(system); return { handle, canvas, context, texture };
  }

  try {
    for (const config of ORIGINAL_AIR_SHOWERS) {
      const name = 'original-airshower-' + config.id;
      const group = createTransformNode(name); setParent(group, root); group.position.set(config.x, 0, config.z);
      group.metadata = { equipmentId: config.equipmentId, isAirShower: true }; airShowers.push(group);
      const { width: w, height: h, depth: d } = config, t = air.wallThickness;
      const stainless = shaded(name + '-stainless-material', 0xd8e0e9, 0.9, 0.22);
      const dark = shaded(name + '-dark-trim-material', 0x1e293b, 0, 0.5);
      const glass = shaded(name + '-glass-material', config.isAmber ? 0xf59e0b : 0x38bdf8, 0, 0.1);
      glass.alpha = config.isAmber ? 0.55 : 0.35; glass.alphaBlend = true;
      setPbrTransmission(glass, { intensity: 0.8, indexOfRefraction: 1.5 });
      const nozzleMaterial = shaded(name + '-nozzle-material', 0x94a3b8, 0.95, 0.1);
      box(name + '-plenum-left', [t, h, d], [-w / 2 + t / 2, h / 2, 0], stainless, group);
      box(name + '-plenum-right', [t, h, d], [w / 2 - t / 2, h / 2, 0], stainless, group);
      box(name + '-top-plenum', [w, air.topHeight, d], [0, h - air.topOffset, 0], stainless, group);
      [-w / 2 + t, w / 2 - t].forEach((x, side) => {
        for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
          const nozzle = cylinder(`${name}-nozzle-${side}-${row}-${column}`, air.nozzle.radiusTop * 2,
            air.nozzle.radiusBottom * 2, air.nozzle.height, air.nozzle.tessellation,
            [x, 0.85 + row * 0.55, -d * 0.35 + column * d * 0.35], nozzleMaterial, group);
          nozzle.rotation.z = side === 0 ? -Math.PI / 2 : Math.PI / 2;
        }
      });
      const indicators: PbrMaterialProps[] = [], doorW = w - air.doorWidthInset, doorH = h - air.doorHeightInset;
      [-d / 2, d / 2].forEach((z, index) => {
        const door = box(`${name}-door-${index}`, [doorW, doorH, air.doorThickness], [0, doorH / 2, z], dark, group);
        box(`${name}-door-${index}-window`, [doorW * air.windowScale, doorH * air.windowScale, air.doorThickness * 1.2], [0, 0, 0], glass, door);
        const indicator = emissive(shaded(`${name}-indicator-${index}-material`, 0x10b981, 0, 0.2), 0x10b981, 0.8);
        indicators.push(indicator);
        box(`${name}-indicator-${index}`, [doorW * air.indicator.widthRatio, air.indicator.height, air.indicator.depth],
          [0, doorH + air.indicator.yInset, z], indicator, group);
      });
      const hmi = box(name + '-hmi', [air.hmi.width, air.hmi.height, air.hmi.depth],
        [w / 2 - air.hmi.xInset, air.hmi.y, d / 2 + air.hmi.zInset], dark, group);
      plane(name + '-hmi-screen', [air.hmiScreen.width, air.hmiScreen.height], [0, 0, air.hmiScreen.z],
        emissive(shaded(name + '-hmi-screen-material', 0x0284c7), 0x0284c7, 0.9), hmi, 0, Math.PI);
      const jets = Array.from({ length: 4 }, (_, index) => {
        const color = rgb(config.isAmber ? 0xfef08a : 0xbae6fd);
        const material = createShaderMaterial({ attributes: ['position'],
          vertexSource: 'struct VertexOutput{@builtin(position)position:vec4<f32>,};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}',
          fragmentSource: '@fragment fn mainFragment()->@location(0)vec4<f32>{return shaderUniforms.color;}',
          uniforms: ['worldViewProjection', { name: 'color', type: 'vec4<f32>', defaultValue: [...color, 0] }],
          needAlphaBlending: true, blendMode: 'additive', depthWrite: false, backFaceCulling: false });
        const mesh = cylinder(`${name}-jet-${index}`, 0, air.jet.radius * 2, air.jet.height, air.jet.tessellation,
          [index % 2 === 0 ? -air.jet.x : air.jet.x, h - air.jet.yOffset, -d * 0.25 + Math.floor(index / 2) * d * 0.5], material, group);
        mesh.rotation.x = Math.PI; return { mesh, material, color };
      });
      const light = createPointLight([0, h - air.innerLight.yOffset, 0], air.innerLight.intensity);
      light.name = name + '-light'; light.diffuse = rgb(config.isAmber ? 0xfef08a : 0xe0f2fe);
      light.specular = [...light.diffuse]; light.range = air.innerLight.range; light.metadata = { legacyDecay: 1 };
      setParent(light, group); light.position.set(0, h - air.innerLight.yOffset, 0); addToScene(scene, light); lights.push(light);
      const art = label(config);
      chambers.push({ id: config.equipmentId, group, indicators, jets, light, label: art?.handle,
        labelArt: art && { canvas: art.canvas, context: art.context, texture: art.texture, isAmber: config.isAmber },
        labelY: h + air.sprite.yOffset });
    }
    ORIGINAL_STICKY_MATS.forEach((config, index) => {
      const name = 'original-sticky-mat-' + index, group = createTransformNode(name);
      setParent(group, root); group.position.set(config.x, 0, config.z); group.rotation.y = config.rotationY;
      const frame = box(name + '-frame', [config.width + mat.frameBorder * 2, mat.frameThickness, config.length + mat.frameBorder * 2],
        [0, mat.frameThickness / 2, 0], shaded(name + '-frame-material', 0x94a3b8, 0.85, 0.25), group);
      frame.receiveShadows = true;
      const surface = plane(name + '-surface', [config.width, config.length], [0, mat.frameThickness + mat.matOffset, 0],
        shaded(name + '-surface-material', 0x1d4ed8, 0.25, 0.18), group, Math.PI / 2); surface.receiveShadows = true;
      plane(name + '-tab', [mat.tab.width, mat.tab.length], [config.width / 2 - mat.tab.xInset, mat.frameThickness + mat.tab.offset, config.length / 2 - mat.tab.zInset],
        shaded(name + '-tab-material', 0xffffff, 0, 0.4), group, Math.PI / 2);
      const mark = shaded(name + '-mark-material', 0x0f172a); setPbrUnlit(mark);
      plane(name + '-mark', [mat.mark.width, mat.mark.length], [config.width / 2 - mat.tab.xInset, mat.frameThickness + mat.mark.offset, config.length / 2 - mat.tab.zInset], mark, group, Math.PI / 2);
    });
    plane('original-ceiling-deck', [ffu.deck.width, ffu.deck.depth], [ffu.deck.x, ffu.deck.y, ffu.deck.z], shaded('original-ceiling-deck-material', 0xf8fafc, 0.1, 0.35), ceiling, -Math.PI / 2);
    const units = createBox(engine, { width: ffu.unit.width, height: ffu.unit.height, depth: ffu.unit.depth });
    units.name = 'original-ffu-batch'; units.material = shaded('original-ffu-unit-material', 0xe2e8f0, 0.25, 0.4);
    units.metadata = { staticShadowCaster: false }; setParent(units, ceiling); addToScene(scene, units); meshes.push(units);
    const matrices = new Float32Array(ORIGINAL_FFU_GRID.x.length * ORIGINAL_FFU_GRID.z.length * 16);
    ORIGINAL_FFU_GRID.x.forEach((x, xi) => ORIGINAL_FFU_GRID.z.forEach((z, zi) => {
      const index = xi * ORIGINAL_FFU_GRID.z.length + zi, o = index * 16;
      matrices[o] = matrices[o+5] = matrices[o+10] = matrices[o+15] = 1;
      matrices[o+12] = x; matrices[o+13] = ffu.unit.y; matrices[o+14] = z;
      parts.push({ name: `original-ffu-${xi}-${zi}`, mesh: units, instanceIndex: index });
    }));
    setThinInstances(units, matrices, matrices.length / 16); enableThinInstanceWorldBounds(units);
    const fixture = shaded('original-ceiling-light-fixture-material', 0xcbd5e1, 0.6, 1);
    ffu.lightAislesX.forEach((x, i) => {
      box(`original-ceiling-light-fixture-${i}`, [ffu.lightFixture.width, ffu.lightFixture.height, ffu.lightFixture.depth], [x, ffu.lightFixture.y, 0], fixture, ceiling);
      const amber = x <= ffu.lithoAisleMaxX, color = amber ? 0xf59e0b : 0xffffff;
      box(`original-ceiling-light-lens-${i}`, [ffu.lightLens.width, ffu.lightLens.height, ffu.lightLens.depth], [x, ffu.lightLens.y, 0],
        emissive(shaded(`original-ceiling-light-lens-${i}-material`, color, 0, 0.1), color, amber ? 1 : 1.25), ceiling);
    });
    const truss = shaded('original-ceiling-truss-material', 0xeab308, 0.45, 0.35), rod = shaded('original-ceiling-rod-material', 0x94a3b8, 0.8, 1);
    ORIGINAL_FFU_GRID.trussZ.forEach((z, zi) => {
      box(`original-ceiling-truss-${zi}`, [ffu.truss.width, ffu.truss.height, ffu.truss.depth], [ffu.truss.x, ffu.truss.y, z], truss, ceiling);
      ORIGINAL_FFU_GRID.braceX.forEach((x, xi) => {
        for (const [side, sign] of [[1, -1], [2, 1]] as const) {
          const brace = box(`original-ceiling-brace-${xi}-${zi}-${side}`, [ffu.brace.width, ffu.brace.height, ffu.brace.depth], [x, ffu.brace.y, z + sign * ffu.brace.zOffset], truss, ceiling);
          brace.rotation.x = -sign * ffu.brace.angle;
        }
        cylinder(`original-ceiling-drop-rod-${xi}-${zi}`, ffu.dropRod.radius * 2, ffu.dropRod.radius * 2, ffu.dropRod.height, 8, [x, ffu.dropRod.y, z], rod, ceiling);
      });
    });
    const tray = shaded('original-cable-tray-material', 0x94a3b8, 0.85, 0.25), cable = shaded('original-cable-material', 0x0284c7, 0, 0.4);
    ffu.cableTray.aislesX.forEach((x, i) => {
      box(`original-cable-tray-${i}`, [ffu.cableTray.width, ffu.cableTray.height, ffu.cableTray.depth], [x, ffu.cableTray.y, 0], tray, ceiling);
      cylinder(`original-ceiling-cable-${i}`, ffu.cable.radius * 2, ffu.cable.radius * 2, ffu.cable.depth, ffu.cable.tessellation, [x, ffu.cable.y, 0], cable, ceiling).rotation.x = Math.PI / 2;
    });
    setSubtreeVisible(ceiling, false);
  } catch (error) { for (const texture of textures) releaseTexture(texture); throw error; }

  function applyAirShowerFrames(frames: readonly AirShowerFrame[]) {
    for (const chamber of chambers) {
      const frame = frames.find(row => row.id === chamber.id); if (!frame) continue;
      for (const indicator of chamber.indicators) {
        indicator.baseColorFactor = [...rgb(frame.indicator.color), 1];
        setPbrEmissive(indicator, rgb(frame.indicator.emissive).map(v => v * frame.indicator.intensity) as [number, number, number]);
        markMaterialUboDirty(indicator);
      }
      chamber.jets.forEach((jet, index) => {
        jet.mesh.scaling.set(frame.jets[index].scale, 1, frame.jets[index].scale);
        setShaderUniform(jet.material, 'color', [...jet.color, frame.jets[index].opacity]);
      });
      setLightIntensity(chamber.light, frame.innerLight); chamber.labelY = frame.labelSpriteY;
    }
  }
  // The product world owns exactly one source personnel clock (the motion module) and calls update().
  // Standalone fixtures without an external provider keep the frozen internal 16 ms clock.
  const timeline = options.frames ? undefined
    : createPersonnelTimeline({ seed: 42, dt: 0.016, clockStartMs: 0, clockMsPerTick: 16, ticks: 0, chamberUserDataMode: 'as-built' });
  let remainder = 0, language: 'zh' | 'en' = 'zh';
  function syncLabels() {
    labelOverlay.syncCamera(scene);
    for (const chamber of chambers) if (chamber.label) {
      const m = chamber.group.worldMatrix;
      updateBillboardSprite(chamber.label, { position: [m[12], m[13] + chamber.labelY, m[14]] });
    }
  }
  if (timeline) onBeforeRender(scene, delta => {
    if (disposed) return;
    remainder = Math.min(0.128, remainder + Math.max(0, delta / 1000));
    let steps = 0;
    while (remainder >= 0.016 && steps++ < 8) { timeline.step(); remainder -= 0.016; }
    applyAirShowerFrames(timeline.readFrame().airShowers);
    syncLabels();
  });
  return { root, ceiling, parts, meshes, lights, labels, airShowers, applyAirShowerFrames,
    registerLabels(): Promise<void> {
      if (disposed) return Promise.resolve();
      return labelOverlay.register(labelSystems);
    },
    setCeilingVisible(visible: boolean) { setSubtreeVisible(ceiling, visible); },
    /** Product frame loop: apply the shared personnel clock's air-shower frame and follow billboards. */
    update() {
      if (disposed) return;
      if (options.frames) applyAirShowerFrames(options.frames());
      syncLabels();
    },
    setLanguage(next: 'zh' | 'en') {
      if (disposed || next === language) return;
      language = next;
      for (const chamber of chambers) {
        const art = chamber.labelArt;
        if (!art) continue;
        drawOriginalAirShowerBillboard(art.context, art.isAmber, next);
        updateDynamicTexture(engine, art.texture, art.canvas, { invertY: false });
      }
    },
    dispose() { disposed = true; labelOverlay.dispose(); for (const texture of textures) releaseTexture(texture); textures.clear(); },
  };
}
