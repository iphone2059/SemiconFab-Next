import {
  addToScene, createBox, createCylinder, createDisc, createDynamicTexture, createGround,
  createSphere, createStandardMaterial, createTransformNode, createTube,
  enableThinInstanceWorldBounds, markMaterialUboDirty, onSceneDispose, releaseTexture,
  setParent, setStandardOpacityTexture, setThinInstanceCount, setThinInstances, updateDynamicTexture,
  type DynamicTexture2D, type EngineContext, type Mesh, type PointLight, type SceneContext,
  type StandardMaterialProps, type TransformNode,
} from '@babylonjs/lite';
import { advanceAmhsState, AMHS_TRAFFIC_SEED, createAmhsRandom, createAmhsState,
  type AmhsStation } from '../../amhs-timeline';
import { PERSONNEL, createPersonnelTimeline } from '../../personnel-timeline';
import type { AmhsStats } from '../../fab-scene';

type Triple = readonly [number, number, number];
type Point = { x: number; y: number; z: number };
type Arc = { positions: Point[]; cumulative: number[]; total: number };
export interface LiteMotionPart { name: string; mesh: Mesh; node: TransformNode; instanceIndex: number }
type Pool = { mesh: Mesh; members: { part: LiteMotionPart; enabled: () => boolean }[]; matrices: Float32Array };
const rgb = (hex: number): [number, number, number] => [(hex >>> 16 & 255) / 255, (hex >>> 8 & 255) / 255, (hex & 255) / 255];
const scaleRgb = (hex: number, intensity: number): [number, number, number] => rgb(hex).map(c => c * intensity) as [number, number, number];

/** Source closed Catmull-Rom (tension .15), sampled at the same 512 intervals as legacy-site. */
function arcFor(points: readonly (readonly [number, number])[]): Arc {
  const positions: Point[] = [], cumulative = [0], count = points.length;
  for (let sample = 0; sample <= 512; sample++) {
    const scaled = (sample / 512 % 1) * count, index = Math.floor(scaled), w = scaled - index;
    const p0 = points[(index - 1 + count) % count], p1 = points[index];
    const p2 = points[(index + 1) % count], p3 = points[(index + 2) % count];
    const w2 = w * w, w3 = w2 * w;
    const coordinates = [0, 1].map(axis => p1[axis] * (2 * w3 - 3 * w2 + 1)
      + (p2[axis] - p0[axis]) * 0.15 * (w3 - 2 * w2 + w)
      + p2[axis] * (-2 * w3 + 3 * w2) + (p3[axis] - p1[axis]) * 0.15 * (w3 - w2));
    const point = { x: coordinates[0], y: 0, z: coordinates[1] }; positions.push(point);
    if (sample) { const previous = positions[sample - 1];
      const dx = point.x - previous.x, dz = point.z - previous.z;
      cumulative.push(cumulative[sample - 1] + Math.sqrt(dx * dx + dz * dz)); }
  }
  return { positions, cumulative, total: cumulative[512] };
}
function arcPoint(arc: Arc, progress: number, out: Point): void {
  const target = ((progress % 1 + 1) % 1) * arc.total;
  let index = 1;
  while (index < 512 && arc.cumulative[index] < target) index++;
  const segment = arc.cumulative[index] - arc.cumulative[index - 1];
  const t = segment > 0 ? (target - arc.cumulative[index - 1]) / segment : 0;
  out.x = arc.positions[index - 1].x + (arc.positions[index].x - arc.positions[index - 1].x) * t;
  out.y = 0;
  out.z = arc.positions[index - 1].z + (arc.positions[index].z - arc.positions[index - 1].z) * t;
}

/** Native scene resources; source coordinates are RH. The composition root reflects them exactly once. */
export function createLiteMotion(scene: SceneContext, engine: EngineContext) {
  const root = createTransformNode('native-motion');
  const amhsRoot = createTransformNode('native-amhs'); setParent(amhsRoot, root);
  const personnelRoot = createTransformNode('procedural-personnel'); setParent(personnelRoot, root);
  const meshes: Mesh[] = [], lights: PointLight[] = [], parts: LiteMotionPart[] = [];
  const pools = new Map<string, Pool>(), textures = new Set<DynamicTexture2D>();
  let disposed = false, language: 'zh' | 'en' = 'zh', remainderMs = 0;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const texture of textures) releaseTexture(texture);
    textures.clear();
  }
  onSceneDispose(scene, dispose);
  const node = (name: string, parent?: TransformNode, at: Triple = [0, 0, 0]) => {
    const result = createTransformNode(name); if (parent) setParent(result, parent);
    result.position.set(...at); return result;
  };
  const material = (name: string, diffuse: number, specular = 0, emissive = 0, intensity = 0) => {
    const result = createStandardMaterial(); result.name = name;
    result.diffuseColor = rgb(diffuse); result.specularColor = rgb(specular);
    result.emissiveColor = scaleRgb(emissive, intensity); return result;
  };
  function own(mesh: Mesh, name: string, material: StandardMaterialProps, parent: TransformNode) {
    // Attach immediately: even a later builder/texture failure leaves GPU allocations owned by the scene.
    addToScene(scene, mesh); meshes.push(mesh);
    mesh.name = name; mesh.material = material; mesh.pickable = false;
    mesh.metadata = { staticShadowCaster: false }; setParent(mesh, parent); return mesh;
  }
  function direct(mesh: Mesh, name: string, at: Triple, mat: StandardMaterialProps, parent: TransformNode) {
    own(mesh, name, mat, parent); mesh.position.set(...at);
    const part = { name, mesh, node: mesh, instanceIndex: 0 }; parts.push(part); return mesh;
  }
  function pooled(name: string, key: string, build: () => Mesh, at: Triple, mat: StandardMaterialProps,
    parent?: TransformNode, enabled: () => boolean = () => true): LiteMotionPart {
    let pool = pools.get(key);
    if (!pool) {
      const mesh = own(build(), 'motion-batch-' + key, mat, amhsRoot);
      pool = { mesh, members: [], matrices: new Float32Array(0) }; pools.set(key, pool);
    }
    // CPU pose nodes live in a root-relative RH frame. The only render nodes are the native batches.
    // This avoids baking the composition root's reflection/explode transform into instance matrices twice.
    const pose = node(name, parent, at), part = { name, mesh: pool.mesh, node: pose, instanceIndex: 0 };
    parts.push(part); pool.members.push({ part, enabled }); return part;
  }
  const arcs = [arcFor([[-33, -27], [26, -27], [42, -27], [42, 28], [18, 28], [-5, 28], [-33, 28]]),
    arcFor([[-27, -24], [20, -24], [20, 25], [-4, 25], [-4, -24]])];
  const stations: AmhsStation[][] = [[28, 52.5, 88, 112, 153, 176, 245], [0, 28, 55, 86, 112, 132, 162.5]]
    .map((list, loop) => list.map((s, index) => ({ id: `L${loop + 1}-ST${String(index + 1).padStart(2, '0')}`,
      loopId: (loop + 1) as 1 | 2, s, bay: '', bayName: '', bayNameZh: '' })));
  const traffic = createAmhsState({ loops: { 1: { length: arcs[0].total, stations: stations[0] },
    2: { length: arcs[1].total, stations: stations[1] } }, initialNextTaskTime: 1,
    vehicles: [1, 2].flatMap(loopId => Array.from({ length: 12 }, (_, i) => ({ loopId: loopId as 1 | 2,
      s: i / 12 * arcs[loopId - 1].total }))) });
  const random = createAmhsRandom(AMHS_TRAFFIC_SEED).random;
  const previousLed = traffic.vehicles.map(vehicle => vehicle.ledHex);
  const ledChanged = traffic.vehicles.map(() => false);
  const personnel = createPersonnelTimeline({ seed: 42, dt: 0.016, clockStartMs: 0, clockMsPerTick: 16,
    ticks: 0, chamberUserDataMode: 'as-built' });
  let frame = personnel.readInitialFrame();
  const initialPatrol = { ...frame.patrol };
  const cars: { body: TransformNode; hoist: TransformNode; foup: TransformNode; cables: TransformNode[]; shadow: TransformNode }[] = [];
  const actors: { root: TransformNode; leftLeg: TransformNode; rightLeg: TransformNode; leftArm: TransformNode;
    rightArm: TransformNode; screen: StandardMaterialProps }[] = [];
  try {
    const bodyMat = material('native-oht-body', 0xf8fafc); bodyMat.specularColor = [0.3, 0.34, 0.38];
    const hoistMat = material('native-oht-hoist', 0x475569, 0xffffff);
    // Lite's native unlit Standard path multiplies emissive by diffuse; white diffuse retains source green output.
    const railMat = material('native-oht-rail', 0xffffff, 0, 0x0e6b4f, 1); railMat.disableLighting = true;
    const foupMat = material('native-oht-foup', 0xdbeafe, 0xffffff, 0x1d4ed8, 0.15);
    const cableMat = material('native-oht-cable', 0x94a3b8, 0xffffff, 0x94a3b8, 0.2);
    const shadowMat = material('native-oht-shadow-material', 0); shadowMat.disableLighting = true; shadowMat.backFaceCulling = false;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('AMHS shadow Canvas2D unavailable');
      const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
      gradient.addColorStop(0, 'rgba(15, 23, 42, 0.34)'); gradient.addColorStop(1, 'rgba(15, 23, 42, 0)');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
      const texture = createDynamicTexture(engine, 64, 64, { srgb: false, mipMaps: true }); textures.add(texture);
      updateDynamicTexture(engine, texture, canvas, { invertY: false }); setStandardOpacityTexture(shadowMat, texture);
    } else shadowMat.alpha = 0.34; // CPU-only construction has no Canvas; browser always uses the source radial decal.
    const ledMaterials = [0x10b981, 0x38bdf8, 0xf59e0b].map(hex => ({ hex,
      initial: material('native-oht-led-initial-' + hex, hex, 0xffffff, hex, 0.8),
      active: material('native-oht-led-active-' + hex, hex, 0xffffff, hex, 1) }));
    arcs.forEach((arc, loop) => {
      direct(createTube(engine, { path: arc.positions.map(p => ({ x: p.x, y: 5.78, z: p.z })), radius: 0.055, tessellation: 8 }),
        `native-oht-rail-${loop}`, [0, 0, 0], railMat, amhsRoot);
      for (let i = 0; i < 513; i += 24) pooled(`native-oht-support-${loop}-${i}`, 'support',
        () => createBox(engine, { width: 0.08, height: 0.55, depth: 0.08 }),
        [arc.positions[i].x, 5.55, arc.positions[i].z], railMat);
      for (let index = 0; index < 12; index++) {
        const suffix = `${loop}-${index}`, id = loop * 12 + index, vehicle = traffic.vehicles[id];
        const body = pooled('native-oht-' + suffix, 'body', () => createBox(engine, { width: 1.6, height: 0.45, depth: 0.95 }),
          [0, 5.8, 0], bodyMat).node;
        const led = node('native-oht-light-' + suffix, body, [0, 0.24, 0]);
        const beacon = node('native-oht-beacon-' + suffix, body, [0, 0.3, 0]);
        for (const [kind, pose, build] of [
          ['light', led, () => createBox(engine, { width: 0.8, height: 0.06, depth: 0.12 })],
          ['beacon', beacon, () => createSphere(engine, { diameter: 0.14, segments: 8 })],
        ] as const) {
          let sourcePart: LiteMotionPart | undefined;
          for (const tint of ledMaterials) for (const intensity of ['initial', 'active'] as const) {
            const key = `${kind}-${tint.hex}-${intensity}`;
            let pool = pools.get(key);
            if (!pool) { pool = { mesh: own(build(), 'motion-batch-' + key, tint[intensity], amhsRoot),
              members: [], matrices: new Float32Array(0) }; pools.set(key, pool); }
            sourcePart ??= { name: `native-oht-${kind}-${suffix}`, node: pose, mesh: pool.mesh, instanceIndex: 0 };
            pool.members.push({ part: sourcePart, enabled: () => vehicle.ledHex === tint.hex
              && (ledChanged[id] ? intensity === 'active' : intensity === 'initial') });
          }
          parts.push(sourcePart!);
        }
        for (let wheel = 0; wheel < 4; wheel++) {
          const roller = pooled(`native-oht-wheel-${suffix}-${wheel}`, 'wheel',
            () => createCylinder(engine, { diameter: 0.18, height: 0.08, tessellation: 10 }),
            [wheel < 2 ? -0.54 : 0.54, -0.2, wheel % 2 === 0 ? -0.34 : 0.34], hoistMat, body).node;
          roller.rotation.z = Math.PI / 2;
        }
        const hoist = pooled('native-oht-hoist-' + suffix, 'hoist',
          () => createBox(engine, { width: 0.16, height: 0.55, depth: 0.16 }), [0, -0.48, 0], hoistMat, body).node;
        const foup = pooled('native-oht-foup-' + suffix, 'foup',
          () => createBox(engine, { width: 0.55, height: 0.42, depth: 0.55 }), [0, -0.7, 0], foupMat, hoist,
          () => vehicle.foupVisible).node;
        const cables = [0, 1].map(side => pooled(`native-oht-cable-${suffix}-${side}`, 'cable',
          () => createCylinder(engine, { diameter: 0.024, height: 0.5, tessellation: 6 }),
          [side === 0 ? -0.25 : 0.25, -0.25, 0], cableMat, body).node);
        const shadow = pooled('native-oht-shadow-' + suffix, 'shadow',
          () => createGround(engine, { width: 2.4, height: 1.6 }), [0, 0.053, 0], shadowMat).node;
        cars.push({ body, hoist, foup, cables, shadow });
      }
    });
    const suit = material('procedural-suit', 0xf8fafc), boot = material('procedural-boot', 0x334155);
    const glove = material('procedural-glove', 0x0284c7), visor = material('procedural-visor', 0x0284c7, 0, 0x38bdf8, 0.25);
    visor.alpha = 0.82; visor.specularColor = [1, 1, 1];
    const tablet = material('procedural-tablet', 0x0f172a);
    const screen = material('procedural-tablet-screen', 0x38bdf8, 0xffffff, 0x0284c7, 0.8);
    const shadow = material('procedural-operator-shadow', 0); shadow.alpha = 0.16;
    shadow.disableLighting = true; shadow.backFaceCulling = false;
    PERSONNEL.forEach((config, i) => {
      const actor = node(`operator-${i}`, personnelRoot, [config.x, 0, config.z]); actor.rotation.y = config.rotY;
      const box = (name: string, size: Triple, at: Triple, mat: StandardMaterialProps, parent = actor) =>
        direct(createBox(engine, { width: size[0], height: size[1], depth: size[2] }), name + '-' + i, at, mat, parent);
      const cylinder = (name: string, diameter: number, height: number, at: Triple, parent: TransformNode) =>
        direct(createCylinder(engine, { diameter, height, tessellation: 20 }), name + '-' + i, at, suit, parent);
      const disc = direct(createDisc(engine, { radius: 0.46, tessellation: 24 }), `operator-ground-shadow-${i}`, [0, 0.06, 0], shadow, actor);
      disc.rotation.x = Math.PI / 2;
      const leftLeg = node(`operator-leg-pivot-left-${i}`, actor, [-0.11, 0.82, 0]);
      const rightLeg = node(`operator-leg-pivot-right-${i}`, actor, [0.11, 0.82, 0]);
      cylinder('operator-leg-left', 0.14, 0.68, [0, -0.34, 0], leftLeg);
      cylinder('operator-leg-right', 0.14, 0.68, [0, -0.34, 0], rightLeg);
      box('operator-boot-left', [0.14, 0.14, 0.26], [0, -0.75, 0.02], boot, leftLeg);
      box('operator-boot-right', [0.14, 0.14, 0.26], [0, -0.75, 0.02], boot, rightLeg);
      box('operator-torso', [0.38, 0.66, 0.24], [0, 1.15, 0], suit);
      box('operator-badge', [0.08, 0.11, 0.02], [0.1, 1.32, 0.125], material('procedural-badge-' + config.badgeColor, config.badgeColor));
      box('operator-visormount', [0.22, 0.08, 0.13], [0, 1.63, 0.1], visor);
      box('operator-mask', [0.18, 0.08, 0.11], [0, 1.54, 0.09], suit);
      direct(createSphere(engine, { diameter: 0.3, segments: 12 }), `operator-hood-${i}`, [0, 1.62, 0], suit, actor).scaling.set(1, 1.1, 1.05);
      const leftArm = node(`operator-arm-pivot-left-${i}`, actor, [-0.21, 1.32, 0.04]);
      const rightArm = node(`operator-arm-pivot-right-${i}`, actor, [0.21, 1.32, 0.04]);
      cylinder('operator-arm-left', 0.1, 0.36, [0, -0.18, 0], leftArm).rotation.z = -0.2;
      cylinder('operator-arm-right', 0.1, 0.36, [0, -0.18, 0], rightArm).rotation.z = 0.2;
      direct(createSphere(engine, { diameter: 0.085, segments: 8 }), `operator-hand-left-${i}`, [-0.07, -0.36, 0.1], glove, leftArm);
      direct(createSphere(engine, { diameter: 0.085, segments: 8 }), `operator-hand-right-${i}`, [0.07, -0.36, 0.1], glove, rightArm);
      box('operator-tablet', [0.26, 0.18, 0.02], [0, 1.2, 0.28], tablet).rotation.x = -0.55;
      const actorScreen = config.isPatrol ? material('procedural-patrol-screen', 0x38bdf8, 0xffffff, 0x0284c7, 0.8) : screen;
      box('operator-screen', [0.23, 0.15, 0.006], [0, 1.2, 0.295], actorScreen);
      actors.push({ root: actor, leftLeg, rightLeg, leftArm, rightArm, screen: actorScreen });
    });
    for (const pool of pools.values()) {
      pool.matrices = new Float32Array(pool.members.length * 16);
      setThinInstances(pool.mesh, pool.matrices, pool.members.length); enableThinInstanceWorldBounds(pool.mesh);
    }
    project();
  } catch (error) { dispose(); throw error; }

  function project() {
    const point = { x: 0, y: 0, z: 0 }, ahead = { x: 0, y: 0, z: 0 };
    for (let id = 0; id < cars.length; id++) {
      const car = cars[id], vehicle = traffic.vehicles[id], arc = arcs[vehicle.loopId - 1];
      if (previousLed[id] !== vehicle.ledHex) { ledChanged[id] = true; previousLed[id] = vehicle.ledHex; }
      const progress = ((vehicle.s / arc.total % 1) + 1) % 1;
      arcPoint(arc, progress, point); arcPoint(arc, (progress + 0.002) % 1, ahead);
      car.body.position.set(point.x, 5.8, point.z);
      // Source Quaternion.FromUnitVectors(Right,tangent), preserving RH forward along local +X.
      car.body.rotation.y = -Math.atan2(ahead.z - point.z, ahead.x - point.x);
      car.shadow.position.set(point.x + 1.15, 0.053, point.z + 1.3);
      car.shadow.rotation.y = Math.atan2(ahead.x - point.x, ahead.z - point.z);
      car.hoist.position.y = -0.48 + vehicle.hoistY; car.foup.visible = vehicle.foupVisible;
      for (const cable of car.cables) { cable.scaling.y = vehicle.cableScaleY; cable.position.y = vehicle.cableY - 5.8; }
    }
    for (const pool of pools.values()) {
      let count = 0;
      for (const member of pool.members) {
        if (!member.enabled()) continue;
        member.part.mesh = pool.mesh; member.part.instanceIndex = count;
        pool.matrices.set(member.part.node.worldMatrix, count++ * 16);
      }
      setThinInstanceCount(pool.mesh, count);
    }
    actors.forEach((actor, i) => {
      const pose = frame.actors[i]; actor.root.position.set(pose.x, pose.y, pose.z); actor.root.rotation.y = pose.rotY;
      if (!PERSONNEL[i].isPatrol) return;
      actor.leftLeg.rotation.x = frame.patrol.legs.left; actor.rightLeg.rotation.x = frame.patrol.legs.right;
      actor.leftArm.rotation.x = frame.patrol.arms.left; actor.rightArm.rotation.x = frame.patrol.arms.right;
      actor.screen.diffuseColor = rgb(frame.patrol.screenColor);
      actor.screen.emissiveColor = scaleRgb(frame.patrol.screenEmissive, frame.patrol.screenEmissiveIntensity);
      markMaterialUboDirty(actor.screen);
    });
  }
  return {
    root, amhsRoot, personnelRoot, meshes, lights, parts, patrolRoot: actors[5].root,
    update(deltaMs: number, _nowMs: number) {
      if (disposed || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      // Source AMHS uses one clamped source frame, whereas personnel owns the literal 16ms clock.
      advanceAmhsState(traffic, deltaMs / 1000, random);
      remainderMs = Math.min(128, remainderMs + deltaMs);
      let steps = 0;
      while (remainderMs >= 16 && steps++ < 8) { personnel.step(); remainderMs -= 16; }
      frame = personnel.readFrame(); project();
    },
    readStats(): AmhsStats { return { active: traffic.vehicles.filter(v => v.state !== 'IDLE').length,
      total: traffic.vehicles.length, queued: traffic.queue.length, completed: traffic.completed.length,
      avgDelivery: traffic.completed.length ? traffic.totalDeliveryTime / traffic.completed.length : null }; },
    patrolPosition(): Triple { const actor = frame.actors[5]; return [actor.x, actor.y, actor.z]; },
    readAirShowerFrames() { return personnel.readFrame().airShowers; },
    /** As-built source loses the status-sprite update reference: locale redraws the frozen initial board. */
    readPatrolStatus() { return { phase: initialPatrol.phase, text: language === 'zh' ? initialPatrol.statusTextZh : initialPatrol.statusTextEn,
      y: 2.15, width: 3.2, height: 0.8 }; },
    setLanguage(value: 'zh' | 'en') { if (!disposed) language = value; },
    /** World-space OHT body poses for acceptance (source RH metres, before the render frame reflection). */
    readVehiclePositions() {
      return cars.map(car => ({ position: [car.body.position.x, car.body.position.y, car.body.position.z] as Triple,
        rotationY: car.body.rotation.y, hoistY: car.hoist.position.y, foupVisible: car.foup.visible !== false }));
    },
    readSnapshot() { return { simTime: traffic.simTime, personnel: personnel.readFrame(),
      loops: arcs.map((arc, i) => ({ length: arc.total, samples: arc.positions.length, stations: stations[i].map(s => ({ ...s })) })),
      vehicles: traffic.vehicles.map(v => ({ id: v.id, loopId: v.loopId, s: v.s, speed: v.speed, state: v.state,
        hoistY: v.hoistY, cableScaleY: v.cableScaleY, cableY: v.cableY, foupVisible: v.foupVisible, ledHex: v.ledHex })) }; },
    prepareForDeviceRecovery() {
      if (disposed) return;
      for (const pool of pools.values()) {
        const count = pool.mesh.thinInstances!.count;
        pool.mesh.thinInstances = null;
        setThinInstances(pool.mesh, pool.matrices, pool.members.length); setThinInstanceCount(pool.mesh, count);
      }
    },
    dispose,
  };
}
