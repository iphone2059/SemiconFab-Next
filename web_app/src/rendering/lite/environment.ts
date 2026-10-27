import {
  addToScene, createBox, createCylinder, createPlane, createTorus, createTransformNode, setParent,
  createPbrMaterial, setPbrEmissive, setPbrUnlit, createDynamicTexture, updateDynamicTexture, releaseTexture,
  createGridSpriteAtlas, createFacingBillboardSystem, addBillboardSpriteIndex, updateBillboardSpriteIndex,
  billboardBlendAdditive, setSubtreeVisible, createShaderMaterial, setShaderTexture,
  type SceneContext, type EngineContext, type Mesh, type TransformNode, type Material, type PointLight,
  type DynamicTexture2D, type BillboardSpriteInit,
} from '@babylonjs/lite';
import { createOverlayBillboards } from './overlay-billboards';
import { FAB_LAYOUT } from '../../fab-layout';
import { advanceLaminarParticle, classifyCleanroomPressure, cleanroomPressureField } from '../../cleanroom-pressure';
import { renderAirflowHeatmapCanvas } from '../../airflow-texture';
import { ORIGINAL_EXPLODED_LINKS, explodedLinkFrame } from '../../original-exploded-link-data';
import {
  ORIGINAL_ROOF_SLAB as slab, ORIGINAL_ROOF_PARAPETS as parapets, ORIGINAL_ROOF_MAUS as maus,
  ORIGINAL_ROOF_MAU as mau, ORIGINAL_ROOF_SUPPLY_MAINS as mains, ORIGINAL_ROOF_SUPPLY_FEEDER as feeder,
  ORIGINAL_ROOF_BAY_DROPS as drops, ORIGINAL_ROOF_SUPPLY_DROP as drop, ORIGINAL_ROOF_CHIMNEYS as chimneys,
  ORIGINAL_ROOF_EXHAUST as exhaust, drawOriginalRoofSprite, ROOF_SPRITE_CANVAS,
} from './environment-roof-data';

type Triple = [number, number, number];
const rgb = (hex: number): Triple => [hex >>> 16 & 255, hex >>> 8 & 255, hex & 255].map(v => v / 255) as Triple;
type BillboardSystem = ReturnType<typeof createFacingBillboardSystem>;
interface AirflowParticle { x: number; y: number; z: number; vy: number; colorIndex: number; patch: Partial<BillboardSpriteInit> & { position: Triple } }
interface RoofParticle { x: number; y: number; z: number; speed: number; patch: Partial<BillboardSpriteInit> & { position: Triple } }

/** Source RH metres. The composition owner reflects `root` once at the render boundary.
 * Billboards have world positions, so update() projects those positions through their layer roots.
 * Native 1.36 billboard systems must be registered in an explicitly owned recovery scene (see
 * LITE-GAP-RECOVERY-002). This module never adds deferred billboard renderables to the main scene.
 */
export function createLiteEnvironment(scene: SceneContext, engine: EngineContext) {
  const root = createTransformNode('lite-environment');
  const layer = (name: string) => { const node = createTransformNode(name); setParent(node, root); return node; };
  const roofRoot = layer('roofHVACLayer'), airflowRoot = layer('native-airflow'), heatmapRoot = layer('native-pressure-field');
  const linksRoot = layer('original-exploded-interconnects');
  const meshes: Mesh[] = [], lights: PointLight[] = [], textures = new Set<DynamicTexture2D>();
  const billboardSystems: BillboardSystem[] = [];
  const overlay = createOverlayBillboards(scene, engine);
  overlay.setName('environment-labels');
  const roofParticles: RoofParticle[] = [], airflowParticles: AirflowParticle[] = [];
  const labels: { position: Triple; language: 'zh' | 'en'; nameEn: string; nameZh: string;
    canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; texture: DynamicTexture2D; system: BillboardSystem; patch: Partial<BillboardSpriteInit> & { position: Triple } }[] = [];
  const links: { tube: Mesh; ring: Mesh; phase: number }[] = [];
  let disposed = false, language: 'zh' | 'en' = 'zh', factor = 0;
  let roofVisible = false, airflowVisible = false, heatmapVisible = false;
  let roofLastTime: number | null = null, roofPending = 0, clock = 0, lastTextureUpdate = 0;
  let roofSystem: BillboardSystem, airflowSystem: BillboardSystem;
  let heatmapCanvas: HTMLCanvasElement, heatmapTexture: DynamicTexture2D;
  let seed = 0x464142;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const obstacles = FAB_LAYOUT.map(tool => ({ x: tool.x, z: tool.z, halfW: tool.width / 2 + 0.35, halfL: tool.depth / 2 + 0.35, topY: tool.height }));
  const lithoColor: [number, number, number, number] = [0.98, 0.75, 0.14, 0.72];
  const airlockColor: [number, number, number, number] = [0.98, 0.55, 0.2, 0.72];
  const bayColor: [number, number, number, number] = [0.22, 0.74, 0.98, 0.72];
  /** Classified pressure band -> sprite colour; the band index is cached per particle so the patch is only written on a change. */
  const airflowColor = (colorIndex: number): [number, number, number, number] =>
    colorIndex === 0 ? lithoColor : colorIndex === 1 ? airlockColor : bayColor;
  const airflowColorIndex = (highPressure: boolean, isAirlock: boolean) => highPressure ? 0 : isAirlock ? 1 : 2;
  const shaded = (name: string, color: number, metallic = 0, roughness = 1) => {
    const material = createPbrMaterial({ baseColorFactor: [...rgb(color), 1], metallicFactor: metallic,
      roughnessFactor: roughness, directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false });
    material.name = name; return material;
  };
  function finish(mesh: Mesh, name: string, position: Triple, material: Material, parent = roofRoot) {
    // Register immediately: the scene owns geometry even if a later Canvas/upload step fails.
    addToScene(scene, mesh); meshes.push(mesh);
    mesh.name = name; mesh.material = material; setParent(mesh, parent); mesh.position.set(...position);
    mesh.metadata = {}; return mesh;
  }
  const box = (name: string, size: { width: number; height: number; depth: number }, at: Triple, material: Material, parent = roofRoot) =>
    finish(createBox(engine, size), name, at, material, parent);
  const cylinder = (name: string, top: number, bottom: number, height: number, tessellation: number, at: Triple, material: Material, parent = roofRoot) =>
    finish(createCylinder(engine, { diameterTop: top, diameterBottom: bottom, height, tessellation }), name, at, material, parent);
  const duct = (mesh: Mesh, tooltipEn: string, tooltipZh: string) => {
    mesh.metadata = { isDuct: true, tooltipEn, tooltipZh }; return mesh;
  };
  function canvas(width: number, height: number) {
    if (typeof document === 'undefined') throw new Error('Lite environment requires Canvas2D for source textures');
    const result = document.createElement('canvas'); result.width = width; result.height = height;
    const context = result.getContext('2d'); if (!context) throw new Error('Lite environment Canvas2D unavailable');
    return { canvas: result, context };
  }
  function texture(source: HTMLCanvasElement, mipMaps = false) {
    const result = createDynamicTexture(engine, source.width, source.height, { srgb: false, mipMaps });
    textures.add(result); updateDynamicTexture(engine, result, source, { invertY: false }); return result;
  }
  function system(source: DynamicTexture2D, capacity: number, additive = false) {
    const atlas = createGridSpriteAtlas(source, { cellWidthPx: source.width, cellHeightPx: source.height });
    const result = createFacingBillboardSystem(atlas, { capacity, visible: false,
      ...(additive ? { blendMode: billboardBlendAdditive } : {}) });
    billboardSystems.push(result); return result;
  }
  function project(position: Triple, target: Triple, parent: TransformNode) {
    const m = parent.worldMatrix, x = position[0], y = position[1], z = position[2];
    target[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    target[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    target[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  function syncBillboards(visibleOnly = false) {
    const roofMatrix = roofRoot.worldMatrix, airflowMatrix = airflowRoot.worldMatrix;
    if (!visibleOnly || roofVisible) roofParticles.forEach((particle, index) => {
      const m = roofMatrix, target = particle.patch.position;
      target[0] = m[0] * particle.x + m[4] * particle.y + m[8] * particle.z + m[12];
      target[1] = m[1] * particle.x + m[5] * particle.y + m[9] * particle.z + m[13];
      target[2] = m[2] * particle.x + m[6] * particle.y + m[10] * particle.z + m[14];
      updateBillboardSpriteIndex(roofSystem, index, particle.patch);
    });
    if (!visibleOnly || airflowVisible) airflowParticles.forEach((particle, index) => {
      const m = airflowMatrix, target = particle.patch.position;
      target[0] = m[0] * particle.x + m[4] * particle.y + m[8] * particle.z + m[12];
      target[1] = m[1] * particle.x + m[5] * particle.y + m[9] * particle.z + m[13];
      target[2] = m[2] * particle.x + m[6] * particle.y + m[10] * particle.z + m[14];
      updateBillboardSpriteIndex(airflowSystem, index, particle.patch);
    });
    if (!visibleOnly || roofVisible) for (const label of labels) {
      project(label.position, label.patch.position, roofRoot); updateBillboardSpriteIndex(label.system, 0, label.patch);
    }
  }
  function dispose() {
    if (disposed) return; disposed = true;
    overlay.dispose();
    for (const system of billboardSystems) system.visible = false;
    for (const item of textures) releaseTexture(item); textures.clear();
  }
  try {
    const concrete = shaded('original-roof-slab-material', slab.color, slab.metalness, slab.roughness);
    box('original-roof-slab', slab, [slab.x, slab.y, slab.z], concrete).receiveShadows = true;
    const parapetMaterial = shaded('original-roof-parapet-material', 0x94a3b8, 0.2, 0.7);
    for (const part of parapets) box('original-roof-parapet-' + part.id, part, [part.x, part.y, part.z], parapetMaterial);
    const enclosure = shaded('original-roof-mau-enclosure-material', 0x94a3b8, 0.55, 0.35);
    const louvers = shaded('original-roof-mau-louver-material', 0x334155, 0.4, 0.7);
    const fans = shaded('original-roof-mau-fan-material', 0x475569, 0.6, 0.3);
    for (const record of maus) {
      const name = 'original-roof-' + record.id.toLowerCase(), group = createTransformNode(name);
      group.position.set(record.x, mau.groupY, record.z); setParent(group, roofRoot);
      const body = duct(box(name + '-body', mau.body, [0, 0, 0], enclosure, group),
        record.nameEn + ' → Cleanroom Make-up Air & Filtration', record.nameZh + ' → 洁净厂房新风预调理与高效过滤');
      body.receiveShadows = true;
      // Native plane faces -Z, source front faces +Z.
      const front = finish(createPlane(engine, mau.louver), name + '-louver', [0, 0, mau.louver.z], louvers, group);
      front.rotation.y = Math.PI;
      [-mau.fanCowl.localX, mau.fanCowl.localX].forEach((x, index) => cylinder(name + '-cowl-' + (index + 1),
        mau.fanCowl.radius * 2, mau.fanCowl.radius * 2, mau.fanCowl.height, mau.fanCowl.tessellation,
        [x, mau.fanCowl.localY, 0], fans, group));
      box(name + '-curb', mau.curb, [0, mau.curb.localY, 0], parapetMaterial, group);
    }
    const supply = shaded('original-roof-supply-duct-material', 0x7db8e8, 0.3, 0.35);
    for (const main of mains) duct(box('original-roof-supply-main-' + main.line, { width: 81, height: 0.8, depth: 1.2 }, [4.5, 8.65, main.z], supply), main.tooltipEn, main.tooltipZh);
    for (const record of maus) duct(box('original-roof-supply-feeder-' + record.id.toLowerCase(), feeder, [record.x, feeder.y, feeder.z], supply),
      'Supply Distribution Header (' + record.id + ') → Process Mains', '送风分配总管 (' + record.id + ') → 各工艺分支主管');
    drops.forEach((record, index) => duct(box('original-roof-supply-drop-' + index, drop, [record.x, drop.y, record.z], supply),
      'Supply air branch → ' + record.nameEn, '送风支管 → ' + record.nameZh));
    const exhaustMaterial = shaded('original-roof-exhaust-material', 0xe8935a, 0.3, 0.35);
    for (const record of chimneys) {
      const name = record.stack.slice(1), tooltipEn = 'Exhaust Chimney (Stack ' + record.stack + ') → ' + record.nameEn;
      const tooltipZh = '工艺排气烟囱 (' + record.stack + ') → ' + record.nameZh;
      duct(cylinder('original-roof-exhaust-stack-' + name, exhaust.stack.radius * 2, exhaust.stack.radius * 2,
        exhaust.stack.height, exhaust.stack.tessellation, [record.x, exhaust.stack.y, record.z], exhaustMaterial), tooltipEn, tooltipZh);
      duct(cylinder('original-roof-exhaust-cowl-' + name, exhaust.cowl.radiusTop * 2, exhaust.cowl.radiusBottom * 2,
        exhaust.cowl.height, exhaust.cowl.tessellation, [record.x, exhaust.cowl.y, record.z], exhaustMaterial), tooltipEn, tooltipZh);
    }
    const white = canvas(1, 1); white.context.fillStyle = '#ffffff'; white.context.fillRect(0, 0, 1, 1);
    roofSystem = system(texture(white.canvas), 70);
    for (const record of chimneys) for (let index = 0; index < exhaust.particlesPerStack; index++) {
      const angle = Math.random() * Math.PI * 2, radius = Math.random() * exhaust.radiusJitter;
      const x = record.x + Math.cos(angle) * radius, y = exhaust.spawnBaseY + Math.random() * exhaust.spawnJitterY, z = record.z + Math.sin(angle) * radius;
      const patch = { position: [x, y, z] as Triple };
      addBillboardSpriteIndex(roofSystem, { ...patch, sizeWorld: [exhaust.particleSize, exhaust.particleSize], color: [...rgb(exhaust.particleColor), exhaust.particleOpacity] });
      roofParticles.push({ x, y, z, speed: exhaust.minSpeed + Math.random() * exhaust.speedJitter, patch });
    }
    const laminar = canvas(64, 128), ctx = laminar.context;
    const gradient = ctx.createRadialGradient(32, 64, 2, 32, 64, 28);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.2, 'rgba(186,230,253,.95)');
    gradient.addColorStop(0.6, 'rgba(56,189,248,.4)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.scale(0.55, 2); ctx.beginPath(); ctx.arc(32 / 0.55, 64 / 2, 28, 0, Math.PI * 2);
    ctx.fillStyle = gradient; ctx.fill(); ctx.restore();
    airflowSystem = system(texture(laminar.canvas), 1500, true);
    for (let index = 0; index < 1500; index++) {
      const x = -46 + random() * 92, z = -34 + random() * 68, y = 0.05 + random() * 7.85;
      const field = cleanroomPressureField(x, z), vy = (field.isLitho ? 0.046 : 0.036) + (random() - 0.5) * 0.008;
      const colorIndex = airflowColorIndex(field.pressure >= 26, field.isAirlock);
      const patch = { position: [x, y, z] as Triple, color: airflowColor(colorIndex) };
      addBillboardSpriteIndex(airflowSystem, { ...patch, sizeWorld: [0.45, 0.45] }); airflowParticles.push({ x, y, z, vy, patch, colorIndex });
    }
    for (const record of maus) {
      const label = canvas(ROOF_SPRITE_CANVAS.width, ROOF_SPRITE_CANVAS.height);
      drawOriginalRoofSprite(label.context, record.nameEn, record.nameZh, language);
      const labelTexture = texture(label.canvas, true), labelSystem = system(labelTexture, 1);
      const position: Triple = [record.x, mau.groupY + mau.sprite.localY, record.z];
      const patch = { position: [...position] as Triple };
      addBillboardSpriteIndex(labelSystem, { ...patch, sizeWorld: [mau.sprite.width, mau.sprite.height] });
      labels.push({ ...label, position, texture: labelTexture, system: labelSystem, language, nameEn: record.nameEn, nameZh: record.nameZh, patch });
    }
    heatmapCanvas = canvas(1024, 768).canvas; renderAirflowHeatmapCanvas(heatmapCanvas);
    heatmapTexture = texture(heatmapCanvas);
    // Native ShaderMaterial expresses the source unlit texture, disabled depth write and -4
    // polygon bias directly; StandardMaterial's public data has no depth-bias control.
    const heatmapMaterial = createShaderMaterial({ attributes: ['position', 'uv'], uniforms: ['worldViewProjection'], samplers: ['heatmap'],
      vertexSource: 'struct VertexOutput{@builtin(position)position:vec4<f32>,@location(0)uv:vec2<f32>,};@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);out.uv=input.uv;return out;}',
      fragmentSource: '@fragment fn mainFragment(@location(0)uv:vec2<f32>)->@location(0)vec4<f32>{let color=textureSample(heatmap,heatmapSampler,uv);return vec4<f32>(color.rgb,color.a*0.88);}',
      needAlphaBlending: true, backFaceCulling: false, depthWrite: false, depthBias: -4, depthBiasSlopeScale: -4 });
    setShaderTexture(heatmapMaterial, 'heatmap', heatmapTexture);
    const heatmapMesh = finish(createPlane(engine, { width: 94, height: 70 }), 'airflowHeatmap', [0, 0.035, 0], heatmapMaterial, heatmapRoot);
    heatmapMesh.rotation.x = Math.PI / 2; heatmapMesh.metadata = { staticShadowCaster: false };
    const pulse = shaded('original-exploded-pulse-white', 0xffffff); setPbrUnlit(pulse);
    ORIGINAL_EXPLODED_LINKS.forEach((record, index) => {
      const material = shaded('original-exploded-link-' + record.subId, record.color, 0.8, 0.2);
      setPbrEmissive(material, rgb(record.color).map(v => v * 0.85) as Triple); material.alpha = 0.85; material.alphaBlend = true;
      const tube = cylinder('original-interconnect-' + record.subId, 0.28, 0.28, 7, 16,
        [(record.hostX + record.subX) / 2, -3.5, (record.hostZ + record.subZ) / 2], material, linksRoot);
      tube.metadata = { staticShadowCaster: false, connectedTool: record.hostId, subTool: record.subId };
      const ring = finish(createTorus(engine, { diameter: 0.56, thickness: 0.08, tessellation: 20 }),
        'original-interconnect-ring-' + record.subId, [0, 0, 0], pulse, tube); ring.rotation.x = Math.PI / 2;
      ring.metadata = { staticShadowCaster: false };
      links.push({ tube, ring, phase: ((index * 1664525 + 1013904223) >>> 0) / 2 ** 32 * Math.PI * 2 });
    });
    [roofRoot, airflowRoot, heatmapRoot, linksRoot].forEach(node => setSubtreeVisible(node, false));
  } catch (error) { dispose(); throw error; }

  return { root, roofRoot, airflowRoot, heatmapRoot, linksRoot, meshes, lights, billboardSystems,
    diagnostics: { roofParticles, airflowParticles, labels, get airflowClock() { return clock; }, get heatmapUpdates() { return lastTextureUpdate; } },
    syncBillboards,
    update(deltaMs: number, nowMs: number) {
      if (disposed) return;
      overlay.syncCamera(scene);
      if (roofVisible && Number.isFinite(nowMs)) {
        if (roofLastTime === null) roofLastTime = nowMs;
        else {
          const delta = nowMs - roofLastTime; roofLastTime = nowMs;
          if (delta > 0) {
            roofPending += delta; let frames = Math.floor(roofPending / (1000 / 60));
            roofPending -= frames * (1000 / 60); frames = Math.min(120, frames);
            for (let frame = 0; frame < frames; frame++) for (const particle of roofParticles) {
              const next = particle.y + particle.speed;
              particle.y = next > exhaust.recycleY ? exhaust.spawnBaseY + Math.random() * exhaust.recycleJitterY : next;
            }
          }
        }
      }
      if (airflowVisible || heatmapVisible) {
        const dt = Number.isFinite(deltaMs) ? Math.min(0.05, Math.max(0, deltaMs / 1000)) : 0; clock += dt;
        if (airflowVisible) for (const particle of airflowParticles) {
          advanceLaminarParticle(particle, dt, obstacles, random);
          // Original semantics: the colour band comes from the pressure field at the POST-move
          // position. The classification is trig-free, so this replaces the second field sample
          // exactly; the per-particle cache skips redundant patch writes.
          const region = classifyCleanroomPressure(particle.x, particle.z);
          const colorIndex = airflowColorIndex(region.highPressure, region.isAirlock);
          if (colorIndex !== particle.colorIndex) {
            particle.colorIndex = colorIndex; particle.patch.color = airflowColor(colorIndex);
          }
        }
        if (heatmapVisible && clock - lastTextureUpdate >= 0.1) {
          renderAirflowHeatmapCanvas(heatmapCanvas, clock); updateDynamicTexture(engine, heatmapTexture, heatmapCanvas, { invertY: false }); lastTextureUpdate = clock;
        }
      }
      if (factor >= 0.01) for (const entry of links) {
        const frame = explodedLinkFrame(factor, nowMs, entry.phase);
        entry.tube.scaling.y = frame.scaleY; entry.tube.position.y = frame.y; entry.ring.position.y = frame.ringY;
      }
      syncBillboards(true);
    },
    setLayer(layer: 'roof' | 'airflow' | 'heatmap', visible: boolean) {
      if (disposed) return;
      if (layer === 'roof') {
        roofVisible = visible; setSubtreeVisible(roofRoot, visible); roofSystem.visible = visible;
        for (const label of labels) label.system.visible = visible; roofLastTime = null; roofPending = 0;
      } else if (layer === 'airflow') { airflowVisible = visible; setSubtreeVisible(airflowRoot, visible); airflowSystem.visible = visible; }
      else { heatmapVisible = visible; setSubtreeVisible(heatmapRoot, visible); }
      syncBillboards();
    },
    setExplodeFactor(value: number) { if (disposed) return; factor = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; setSubtreeVisible(linksRoot, factor >= 0.01); },
    setLanguage(value: 'zh' | 'en') {
      if (disposed || value === language) return; language = value;
      for (const label of labels) { label.language = value; drawOriginalRoofSprite(label.context, label.nameEn, label.nameZh, value);
        updateDynamicTexture(engine, label.texture, label.canvas, { invertY: false }); }
    },
    /** Runtime beforeStart: rebuild native billboard renderables after mount/recovery. */
    registerBillboards(): Promise<void> { return disposed ? Promise.resolve() : overlay.register(billboardSystems); },
    dispose,
  };
}
