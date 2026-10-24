import { Scene } from '@babylonjs/core/scene';
import { buildProceduralFab } from './procedural-fab';
import { buildOriginalRoofHvac } from './original-roof-hvac';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import '@babylonjs/core/Meshes/instancedMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { FAB_LAYOUT, FAB_LAYOUT_BOUNDS, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { AmhsStats, XRayFilter } from './fab-scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { createNativeStaticShadows } from './native-static-shadows';
import { createAerodynamics } from './aerodynamics';

const color = (hex: string) => Color3.FromHexString(hex);

function addAnimatedAmhs(scene: Scene, onStats?: (stats: AmhsStats) => void): TransformNode {
  const path1 = [
    { x: -33, z: -27 }, { x: 26, z: -27 }, { x: 42, z: -27 },
    { x: 42, z: 28 }, { x: 18, z: 28 }, { x: -5, z: 28 }, { x: -33, z: 28 },
  ].map((p) => new Vector3(p.x, 0, p.z));
  const path2 = [
    { x: -27, z: -24 }, { x: 20, z: -24 }, { x: 20, z: 25 },
    { x: -4, z: 25 }, { x: -4, z: -24 },
  ].map((p) => new Vector3(p.x, 0, p.z));
  // Mirrors THREE.CatmullRomCurve3(..., true, 'catmullrom', 0.15) from the original twin.
  const curvePoint = (points: Vector3[], t: number, tension = 0.15): Vector3 => {
    const count = points.length;
    const scaled = (((t % 1) + 1) % 1) * count;
    const index = Math.floor(scaled) % count;
    const weight = scaled - Math.floor(scaled);
    const p0 = points[(index - 1 + count) % count];
    const p1 = points[index];
    const p2 = points[(index + 1) % count];
    const p3 = points[(index + 2) % count];
    const v0 = p2.subtract(p0).scale(tension);
    const v1 = p3.subtract(p1).scale(tension);
    const w2 = weight * weight;
    const w3 = w2 * weight;
    return p1
      .scale(2 * w3 - 3 * w2 + 1)
      .add(v0.scale(w3 - 2 * w2 + weight))
      .add(p2.scale(-2 * w3 + 3 * w2))
      .add(v1.scale(w3 - w2));
  };

  type ArcPath = { positions: Vector3[]; cumulative: number[]; total: number };
  const buildArc = (points: Vector3[]): ArcPath => {
    const positions: Vector3[] = [];
    const cumulative: number[] = [0];
    const samples = 512;
    for (let index = 0; index <= samples; index += 1) {
      positions.push(curvePoint(points, index / samples));
      if (index > 0) cumulative.push(cumulative[index - 1] + Vector3.Distance(positions[index - 1], positions[index]));
    }
    return { positions, cumulative, total: cumulative[cumulative.length - 1] };
  };
  const arcPoint = (arc: ArcPath, progress: number): Vector3 => {
    const target = (((progress % 1) + 1) % 1) * arc.total;
    let index = 1;
    while (index < arc.cumulative.length - 1 && arc.cumulative[index] < target) index += 1;
    const segment = arc.cumulative[index] - arc.cumulative[index - 1];
    const t = segment > 0 ? (target - arc.cumulative[index - 1]) / segment : 0;
    return Vector3.Lerp(arc.positions[index - 1], arc.positions[index], t);
  };
  const arcs = [buildArc(path1), buildArc(path2)];
  const stationPositions = [
    [28.0, 52.5, 88.0, 112.0, 153.0, 176.0, 245.0],
    [0.0, 28.0, 55.0, 86.0, 112.0, 132.0, 162.5],
  ];
  const stations = stationPositions.map((list, loop) =>
    list.map((s) => ((s % arcs[loop].total) / arcs[loop].total)),
  );

  const group = new TransformNode('native-amhs', scene);
  const bodyMaterial = new StandardMaterial('native-oht-body', scene);
  bodyMaterial.diffuseColor = color('#f8fafc');
  bodyMaterial.specularColor = new Color3(0.3, 0.34, 0.38);
  const lightMaterial = new StandardMaterial('native-oht-light', scene);
  lightMaterial.diffuseColor = color('#10b981');
  lightMaterial.emissiveColor = color('#10b981').scale(0.8);
  const hoistMaterial = new StandardMaterial('native-oht-hoist', scene);
  hoistMaterial.diffuseColor = color('#475569');
  const railMaterial = new StandardMaterial('native-oht-rail', scene);
  railMaterial.diffuseColor = Color3.Black();
  railMaterial.emissiveColor = color('#0e6b4f');
  railMaterial.disableLighting = true;
  railMaterial.specularColor = Color3.Black();
  for (let loop = 0; loop < arcs.length; loop += 1) {
    const railPoints = arcs[loop].positions.map((point) => new Vector3(point.x, 5.78, point.z));
    const rail = MeshBuilder.CreateTube(`native-oht-rail-${loop}`, { path: railPoints, radius: 0.055, tessellation: 8 }, scene);
    rail.material = railMaterial;
    rail.isPickable = false;
    rail.parent = group;
    for (let index = 0; index < arcs[loop].positions.length; index += 24) {
      const point = arcs[loop].positions[index];
      const support = MeshBuilder.CreateBox(`native-oht-support-${loop}-${index}`, { width: 0.08, height: 0.55, depth: 0.08 }, scene);
      support.position.set(point.x, 5.55, point.z);
      support.material = railMaterial;
      support.isPickable = false;
      support.parent = group;
    }
  }

  const shadowTexture = new DynamicTexture('native-oht-shadow-texture', { width: 64, height: 64 }, scene, true);
  const shadowContext = shadowTexture.getContext() as unknown as CanvasRenderingContext2D;
  const shadowGradient = shadowContext.createRadialGradient(32, 32, 1, 32, 32, 31);
  shadowGradient.addColorStop(0, 'rgba(15, 23, 42, 0.34)');
  shadowGradient.addColorStop(1, 'rgba(15, 23, 42, 0)');
  shadowContext.fillStyle = shadowGradient;
  shadowContext.fillRect(0, 0, 64, 64);
  shadowTexture.update(false);
  shadowTexture.hasAlpha = true;
  const shadowMaterial = new StandardMaterial('native-oht-shadow-material', scene);
  shadowMaterial.diffuseColor = Color3.Black();
  shadowMaterial.emissiveColor = Color3.Black();
  shadowMaterial.specularColor = Color3.Black();
  shadowMaterial.opacityTexture = shadowTexture;
  shadowMaterial.disableLighting = true;
  shadowMaterial.backFaceCulling = false;
  const foupMaterial = new StandardMaterial('native-oht-foup', scene);
  foupMaterial.diffuseColor = color('#dbeafe');
  foupMaterial.emissiveColor = color('#1d4ed8').scale(0.15);

  type OhtState = 'idle' | 'toPickup' | 'loading' | 'toDropoff' | 'unloading';
  type OhtTask = { loop: number; pickup: number; dropoff: number; createdAt: number };
  const cars: {
    body: ReturnType<typeof MeshBuilder.CreateBox>;
    arc: ArcPath;
    loop: number;
    index: number;
    progress: number;
    speed: number;
    maxSpeed: number;
    state: OhtState;
    target: number | null;
    dwell: number;
    task: OhtTask | null;
    led: StandardMaterial;
    hoist: ReturnType<typeof MeshBuilder.CreateBox>;
    foup: ReturnType<typeof MeshBuilder.CreateBox>;
    shadow: ReturnType<typeof MeshBuilder.CreateGround>;
  }[] = [];
  for (let loop = 0; loop < 2; loop += 1) {
    for (let index = 0; index < 12; index += 1) {
      const body = MeshBuilder.CreateBox(`native-oht-${loop}-${index}`, { width: 1.6, height: 0.45, depth: 0.95 }, scene);
      body.parent = group;
      body.material = bodyMaterial;
      body.rotationQuaternion = new Quaternion();
      body.isPickable = false;
      const light = MeshBuilder.CreateBox(`native-oht-light-${loop}-${index}`, { width: 0.8, height: 0.06, depth: 0.12 }, scene);
      light.parent = body;
      light.position.y = 0.24;
      const led = lightMaterial.clone(`native-oht-led-${loop}-${index}`) as StandardMaterial;
      light.material = led;
      light.isPickable = false;
      const beacon = MeshBuilder.CreateSphere(`native-oht-beacon-${loop}-${index}`, { diameter: 0.14, segments: 8 }, scene);
      beacon.parent = body;
      beacon.position.y = 0.3;
      beacon.material = led;
      beacon.isPickable = false;
      for (let wheel = 0; wheel < 4; wheel += 1) {
        const roller = MeshBuilder.CreateCylinder(`native-oht-wheel-${loop}-${index}-${wheel}`, { diameter: 0.18, height: 0.08, tessellation: 10 }, scene);
        roller.parent = body;
        roller.rotation.z = Math.PI / 2;
        roller.position.set(wheel < 2 ? -0.54 : 0.54, -0.2, wheel % 2 === 0 ? -0.34 : 0.34);
        roller.material = hoistMaterial;
        roller.isPickable = false;
      }
      const hoist = MeshBuilder.CreateBox(`native-oht-hoist-${loop}-${index}`, { width: 0.16, height: 0.55, depth: 0.16 }, scene);
      hoist.parent = body;
      hoist.position.y = -0.48;
      hoist.material = hoistMaterial;
      hoist.isPickable = false;
      const foup = MeshBuilder.CreateBox(`native-oht-foup-${loop}-${index}`, { width: 0.55, height: 0.42, depth: 0.55 }, scene);
      foup.parent = hoist;
      foup.position.y = 0.44;
      foup.material = foupMaterial;
      foup.isVisible = false;
      foup.isPickable = false;
      const shadow = MeshBuilder.CreateGround(`native-oht-shadow-${loop}-${index}`, { width: 2.4, height: 1.6 }, scene);
      shadow.parent = group;
      shadow.material = shadowMaterial;
      shadow.isPickable = false;
      const progress = (index / 12 + loop * 0.37) % 1;
      cars.push({
        body,
        arc: arcs[loop],
        loop,
        index,
        progress,
        speed: 1.1 + (index % 4) * 0.08,
        maxSpeed: 2.6 + loop * 0.2,
        state: 'idle',
        target: null,
        dwell: 0,
        task: null,
        led,
        hoist,
        foup,
        shadow,
      });
    }
  }

  // Hide every baked AMHS vehicle component (body, lights, hoist, cables) at track height.
  // The track tubes themselves and the tall columns are excluded by their large bounds.
  for (const mesh of scene.meshes) {
    if (!mesh.isVisible || mesh.name.startsWith('native-oht')) continue;
    const bounds = mesh.getBoundingInfo().boundingBox;
    const center = bounds.centerWorld;
    const size = bounds.extendSizeWorld;
    const trackHeight = center.y > 5.25 && center.y < 6.35;
    const utbHeight = center.y > 4.4 && center.y < 5.15;
    if ((trackHeight || utbHeight) && size.x < 4 && size.z < 4 && size.y < 2) {
      mesh.setEnabled(false);
    }
  }

  const setLed = (car: (typeof cars)[number], state: OhtState) => {
    const tint = state === 'loading' || state === 'unloading'
      ? '#f59e0b'
      : state === 'toPickup' || state === 'toDropoff'
        ? '#38bdf8'
        : '#10b981';
    car.led.emissiveColor = color(tint);
    car.led.diffuseColor = color(tint);
  };

  const tasks: OhtTask[] = [];
  let taskTimer = 2.5;
  let completedTasks = 0;
  let totalDeliverySeconds = 0;
  let statsTimer = 0;
  let lastTick = performance.now() / 1000;
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.12, Math.max(0.001, now - lastTick));
    lastTick = now;

    taskTimer -= dt;
    if (taskTimer <= 0 && tasks.length < 8) {
      const loop = Math.random() < 0.5 ? 0 : 1;
      const list = stations[loop];
      const pickupIndex = Math.floor(Math.random() * list.length);
      let dropoffIndex = Math.floor(Math.random() * list.length);
      if (dropoffIndex === pickupIndex) dropoffIndex = (dropoffIndex + 1) % list.length;
      tasks.push({ loop, pickup: list[pickupIndex], dropoff: list[dropoffIndex], createdAt: now });
      taskTimer = 4 + Math.random() * 4;
    }

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      let assigned: (typeof cars)[number] | undefined;
      let assignedDistance = Number.POSITIVE_INFINITY;
      for (const car of cars) {
        if (car.loop !== task.loop || car.state !== 'idle') continue;
        const distance = ((task.pickup - car.progress + 1) % 1);
        if (distance < assignedDistance) {
          assignedDistance = distance;
          assigned = car;
        }
      }
      if (assigned) {
        assigned.state = 'toPickup';
        assigned.target = task.pickup;
        assigned.task = task;
        setLed(assigned, 'toPickup');
        tasks.splice(taskIndex, 1);
        taskIndex -= 1;
      }
    }

    for (const car of cars) {
      if (car.state === 'loading' || car.state === 'unloading') {
        const elapsed = 2.6 - car.dwell;
        const ease = (progress: number) => 0.5 - Math.cos(Math.min(1, Math.max(0, progress)) * Math.PI) / 2;
        if (elapsed < 1.1) {
          car.hoist.position.y = -0.48 - 2.5 * ease(elapsed / 1.1);
        } else if (elapsed < 1.9) {
          car.hoist.position.y = -2.98;
          if (elapsed >= 1.5) car.foup.isVisible = car.state === 'loading';
        } else {
          car.hoist.position.y = -0.48 - 2.5 * (1 - ease((elapsed - 1.9) / 0.7));
        }
        car.dwell = Math.max(0, car.dwell - dt);
        if (car.dwell === 0) {
          car.hoist.position.y = -0.48;
          if (car.state === 'loading') {
            car.state = 'toDropoff';
            car.target = car.task?.dropoff ?? null;
            car.foup.isVisible = true;
            setLed(car, 'toDropoff');
          } else {
            if (car.task) {
              completedTasks += 1;
              totalDeliverySeconds += now - car.task.createdAt;
            }
            car.state = 'idle';
            car.target = null;
            car.task = null;
            car.foup.isVisible = false;
            setLed(car, 'idle');
          }
        }
      } else {
        let gapMeters = Number.POSITIVE_INFINITY;
        for (const other of cars) {
          if (other === car || other.arc !== car.arc) continue;
          const gap = ((other.progress - car.progress + 1) % 1) * car.arc.total;
          if (gap > 0.001 && gap < gapMeters) gapMeters = gap;
        }
        const followingLimit = Math.max(0, gapMeters - 3.2) / car.arc.total;
        const targetDistance = car.target === null ? Number.POSITIVE_INFINITY : (car.target - car.progress + 1) % 1;
        let desiredSpeed = car.state === 'idle' ? 1.35 : car.maxSpeed;
        if (gapMeters < 12) desiredSpeed = Math.min(desiredSpeed, Math.max(0, (gapMeters - 3.2) * 0.9));
        if (car.target !== null) desiredSpeed = Math.min(desiredSpeed, Math.sqrt(2 * 1.8 * Math.max(0, targetDistance * car.arc.total)));
        const acceleration = car.speed < desiredSpeed ? 1.6 : 3.0;
        car.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, desiredSpeed - car.speed));
        const speedLimit = Math.min(followingLimit, targetDistance) * car.arc.total / dt;
        car.speed = Math.min(car.speed, speedLimit);
        let step = car.speed * dt / car.arc.total;
        step = Math.min(step, followingLimit, targetDistance);
        if (car.target !== null && targetDistance <= step + 0.0008) {
          car.progress = car.target;
          if (car.state === 'toPickup') {
            car.state = 'loading';
            car.speed = 0;
            car.dwell = 2.6;
            car.target = null;
            setLed(car, 'loading');
          } else if (car.state === 'toDropoff') {
            car.state = 'unloading';
            car.speed = 0;
            car.dwell = 2.6;
            car.target = null;
            setLed(car, 'unloading');
          }
        } else {
          car.progress = (car.progress + step) % 1;
        }
      }
      const point = arcPoint(car.arc, car.progress);
      const ahead = arcPoint(car.arc, (car.progress + 0.002) % 1);
      car.body.position.set(point.x, 5.8, point.z);
      car.shadow.position.set(point.x + 1.15, 0.053, point.z + 1.3);
      const tangent = ahead.subtract(point).normalize();
      car.shadow.rotation.y = Math.atan2(tangent.x, tangent.z);
      if (car.body.rotationQuaternion) {
        Quaternion.FromUnitVectorsToRef(Vector3.Right(), tangent, car.body.rotationQuaternion);
      }
    }

    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = 0.5;
      onStats?.({
        active: cars.filter((car) => car.state !== 'idle').length,
        total: cars.length,
        queued: tasks.length,
        completed: completedTasks,
        avgDelivery: completedTasks > 0 ? totalDeliverySeconds / completedTasks : null,
      });
    }
  });
  return group;
}

export type LegacyLayer = 'amhs' | 'ceiling' | 'roof' | 'subfab' | 'heatmap' | 'airflow' | 'xray';

export interface LegacyRuntime {
  setLayer(layer: LegacyLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setExploded(active: boolean): void;
  setExplodeFactor(factor: number): void;
  setBasement(active: boolean): void;
  setDual(active: boolean): void;
  setXRayFilter(filter: XRayFilter | null): void;
  setLanguage?(language: 'zh' | 'en'): void;
}

interface StatusLightRuntime {
  setState(index: number, state: FabToolState): void;
}

function addToolStatusLights(scene: Scene): StatusLightRuntime {
  const materials = new Map<string, PBRMaterial>();
  const materialFor = (index: number, state: FabToolState) => {
    const catalog = FAB_LAYOUT[index].originalKind === 'catalog';
    const key = `${state}:${catalog}`;
    let material = materials.get(key);
    if (!material) {
      material = new PBRMaterial(`native-status-${key}`, scene);
      material.albedoColor = color(FAB_TOOL_STATE_META[state].color);
      material.emissiveColor = material.albedoColor.scale(catalog ? 0.85 : 0.9);
      material.metallic = 0; material.roughness = catalog ? 1 : 0.2;
      material.ambientColor = Color3.White(); material.directIntensity = Math.PI;
      material.environmentIntensity = 0; material.maxSimultaneousLights = 8;
      materials.set(key, material);
    }
    return material;
  };
  const lights = FAB_LAYOUT.map((_, index) => scene.getMeshByName(`status-${index}`));
  lights.forEach((mesh, index) => { if (mesh) mesh.material = materialFor(index, FAB_TOOL_STATES[index]); });
  scene.onBeforeRenderObservable.add(() => {
    for (const [key, material] of materials) if (key.startsWith('down:')) {
      material.emissiveColor = color(FAB_TOOL_STATE_META.down.color).scale(0.6 + 0.4 * Math.sin(performance.now() / 180));
    }
  });
  return { setState(index, state) { const mesh = lights[index]; if (mesh) mesh.material = materialFor(index, state); } };
}

/** Build the original single-FAB layout directly with Babylon geometry. */
export async function loadLegacyFab(scene: Scene, onAmhsStats?: (stats: AmhsStats) => void): Promise<LegacyRuntime> {
  const ambient = new HemisphericLight('legacy-ambient', new Vector3(0, 1, 0), scene);
  ambient.diffuse = color('#cfd8dc');
  ambient.groundColor = color('#cfd8dc');
  ambient.intensity = 0.48;
  // Three's AmbientLight is a uniform irradiance term, rather than a ninth punctual light.
  scene.ambientColor = color('#cfd8dc').scale(0.48);
  const fill = new DirectionalLight('legacy-fill', new Vector3(40, -35, 30), scene);
  fill.diffuse = color('#94a3b8');
  fill.intensity = 0.32;

  scene.imageProcessingConfiguration.toneMappingEnabled = false;
  // The original renderer outputs LinearEncoding with NoToneMapping.
  scene.imageProcessingConfiguration.isEnabled = false;
  scene.imageProcessingConfiguration.exposure = 1;
  scene.imageProcessingConfiguration.contrast = 1;

  // The original scene has no environment map. An invented studio cube also
  // changes translucent curtain refraction even when surface IBL is disabled.
  scene.environmentTexture = null;
  scene.environmentIntensity = 0;

  const fab = buildProceduralFab(scene);
  const roofParent = new TransformNode('roof-hvac-parent', scene);
  const roofHvac = buildOriginalRoofHvac(scene, roofParent);
  scene.onBeforeRenderObservable.add(() => roofHvac.update(performance.now()));
  // Original PBR surfaces already receive scene.ambientColor. A hemispheric
  // light here would add a second ambient term (most obvious on floor/columns).
  ambient.excludedMeshes = scene.meshes.filter(mesh => mesh.material instanceof PBRMaterial);
  fab.ceiling.setEnabled(true);
  fab.subfab.setEnabled(false);

  // Fixed original key direction, shared by the native depth and receiver passes.
  const keyLight = new DirectionalLight('native-key', new Vector3(-35, -65, -45), scene);
  keyLight.position = new Vector3(35, 65, 45);
  keyLight.diffuse = color('#fffbf5');
  keyLight.intensity = 1.15;
  for (const [index, value] of [
    [-27.5, -20, 2.6, 16], [-27.5, -10, 2.6, 16], [-27.5, 0, 2.4, 16], [-23.5, -15, 2.2, 14], [-23.5, 3.5, 1.8, 12],
  ].entries()) {
    const [x, z, intensity, range] = value;
    const light = new PointLight(`original-litho-amber-${index}`, new Vector3(x, 5.2, z), scene);
    light.diffuse = color('#f59e0b'); light.intensity = intensity; light.range = range;
  }
  const lithoSpot = new SpotLight('original-litho-spot', new Vector3(-27, 8.5, -9), Vector3.Down(), Math.PI * 4 / 9, 2, scene);
  lithoSpot.diffuse = color('#f59e0b'); lithoSpot.intensity = 3.2; lithoSpot.range = 24;
  lithoSpot.innerAngle = lithoSpot.angle * 0.55;
  const statusLights = addToolStatusLights(scene);
  const airflow = createAerodynamics(scene);
  const heatmap = airflow.heatmap;
  const amhsGroup = addAnimatedAmhs(scene, onAmhsStats);
  // These static meshes are created once; keep the caster list stable to avoid
  // allocating flatMap/filter arrays on every animation frame.
  const staticCasters = [fab.equipment, fab.shell, fab.ceiling, fab.subfab, roofHvac.group]
    .flatMap(root => root.getChildMeshes())
    .filter(mesh => mesh !== fab.floor && !mesh.name.startsWith('procedural-slab') && !mesh.name.startsWith('status-') && mesh.metadata?.staticShadowCaster !== false);
  const shadows = createNativeStaticShadows(scene, scene.getEngine() as WebGPUEngine, keyLight,
    () => staticCasters);
  scene.metadata = { ...scene.metadata, staticShadows: shadows };
  const layerVisibility = { ceiling: true, roof: false, subfab: false, amhs: true, heatmap: false, airflow: false };
  let basementActive = false;
  let dualActive = false;
  let explodeFactor = 0;
  let xrayFilter: XRayFilter | null = null;
  const xrayMaterialAlpha = new Map<number, number>();
  const xrayVisibility = new Map<AbstractMesh, boolean>();
  const isSystemMesh = (mesh: AbstractMesh, filter: XRayFilter): boolean => {
    const name = mesh.name.toLowerCase();
    if (filter === 'amhs') return name.includes('oht') || name.includes('amhs');
    if (!name.startsWith('subfab-')) return false;
    if (filter === 'upw') return name.includes('upw');
    if (filter === 'gas') return name.includes('gas');
    if (filter === 'vac') return name.includes('vac') || name.includes('pump') || name.includes('booster');
    return name.includes('foreline') || name.includes('heated') || name.includes('exhaust');
  };
  const restoreXRay = () => {
    for (const material of scene.materials) {
      const alpha = xrayMaterialAlpha.get(material.uniqueId);
      if (alpha !== undefined) material.alpha = alpha;
    }
    for (const [mesh, visible] of xrayVisibility) mesh.isVisible = visible;
    xrayMaterialAlpha.clear();
    xrayVisibility.clear();
    if (xrayFilter !== null) fab.subfab.setEnabled(basementActive || dualActive || layerVisibility.subfab);
    xrayFilter = null;
  };
  const applyXRay = (filter: XRayFilter | null) => {
    restoreXRay();
    if (!filter) return;
    xrayFilter = filter;
    for (const material of scene.materials) {
      xrayMaterialAlpha.set(material.uniqueId, material.alpha);
      if (material.name.startsWith('original-tool-material-') || material.name.startsWith('subfab-')) {
        material.alpha = filter === 'all' ? 0.18 : 0.12;
      }
      if (material.name.startsWith('native-oht-') && filter !== 'amhs') material.alpha = 0.18;
    }
    if (filter !== 'all' && filter !== 'amhs') {
      fab.subfab.setEnabled(true);
      for (const mesh of fab.subfab.getChildMeshes()) {
        xrayVisibility.set(mesh, mesh.isVisible);
        const matches = isSystemMesh(mesh, filter);
        mesh.isVisible = matches;
        if (matches && mesh.material) mesh.material.alpha = 1;
      }
    }
  };
  const applyExplodeFactor = (factor: number) => {
    const next = Math.max(0, Math.min(1, factor));
    if (next === explodeFactor) return;
    explodeFactor = next;
    fab.equipment.position.y = 2.4 * explodeFactor;
    shadows.invalidate('equipment-exploded');
  };
  const syncLevel = () => {
    const cutaway = basementActive || dualActive;
    fab.floor.setEnabled(!cutaway);
    fab.shell.setEnabled(!basementActive);
    fab.subfab.setEnabled(basementActive || dualActive || layerVisibility.subfab);
    fab.equipment.setEnabled(!basementActive);
    fab.personnel.setEnabled(!basementActive);
    fab.ceiling.setEnabled(!basementActive && !dualActive && layerVisibility.ceiling);
    roofHvac.setVisible(layerVisibility.roof && !basementActive && !dualActive);
    amhsGroup.setEnabled(!basementActive && layerVisibility.amhs);
    heatmap.group.setEnabled(!basementActive && layerVisibility.heatmap);
    airflow.group.setEnabled(!basementActive && layerVisibility.airflow);
    for (const mesh of scene.meshes) {
      if (/^(procedural-slab|native-zone|native-zone-border|native-floor-grid|zone-label|perimeter-wall|perimeter-glass|perimeter-kick|perimeter-door|native-oht-shadow|operator-ground-shadow|procedural-shadow-ground)/.test(mesh.name)) {
        mesh.setEnabled(!cutaway);
      }
    }
  };

  return {
    setLayer(layer, visible) {
      if (layer === 'amhs') {
        layerVisibility.amhs = visible;
        amhsGroup.setEnabled(visible && !basementActive);
        return;
      }
      if (layer === 'heatmap') {
        layerVisibility.heatmap = visible;
        heatmap.group.setEnabled(visible && !basementActive);
        return;
      }
      if (layer === 'airflow') {
        layerVisibility.airflow = visible;
        airflow.group.setEnabled(visible && !basementActive);
        return;
      }
      if (layer === 'xray') {
        applyXRay(visible ? (xrayFilter ?? 'all') : null);
        return;
      }
      if (layer === 'roof') {
        layerVisibility.roof = visible;
        roofHvac.setVisible(visible && !basementActive && !dualActive);
        shadows.invalidate('roof-visibility');
        return;
      }
      const target = layer === 'ceiling' ? fab.ceiling : fab.subfab;
      layerVisibility[layer] = visible;
      target.setEnabled(layer === 'ceiling' ? visible && !basementActive : visible || basementActive || dualActive);
      shadows.invalidate('layer-visibility');
    },
    setToolState(index, state) {
      statusLights.setState(index, state);
    },
    setExploded(active) {
      applyExplodeFactor(active ? 1 : 0);
    },
    setExplodeFactor(factor) {
      applyExplodeFactor(factor);
    },
    setBasement(active) {
      basementActive = active;
      if (active) dualActive = false;
      syncLevel();
      shadows.invalidate('basement-visibility');
    },
    setDual(active) {
      dualActive = active;
      if (active) basementActive = false;
      syncLevel();
      shadows.invalidate('dual-visibility');
    },
    setXRayFilter(filter) {
      applyXRay(filter);
    },
    setLanguage(language) {
      roofHvac.setLanguage(language);
    },
  };
}
