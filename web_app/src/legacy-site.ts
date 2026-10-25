import { Scene } from '@babylonjs/core/scene';
import { buildProceduralFab } from './procedural-fab';
import { buildOriginalRoofHvac } from './original-roof-hvac';
import { buildOriginalFacilityArchitecture } from './original-facility-architecture';
import { buildOriginalSubfabFacilities } from './original-subfab-facilities';
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
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from './fab-layout';
import type { AmhsStats, XRayFilter } from './fab-scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { createNativeStaticShadows } from './native-static-shadows';
import { createAerodynamics } from './aerodynamics';
import { advanceAmhsState, AMHS_LED_COLORS, AMHS_TRAFFIC_SEED, createAmhsRandom, createAmhsState, type AmhsStation } from './amhs-timeline';
import { xraySurfaceState, XrayMaterialPalette, type XraySurfaceRole } from './xray-hologram';
import { createPersonnelTimeline } from './personnel-timeline';
import { advanceExplodeFactor, explodedPlacement, originalFloorOpacity } from './twin-spatial';
import { buildOriginalExplodedLinks } from './original-exploded-links';
import type { Material } from '@babylonjs/core/Materials/material';

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
  const stations: AmhsStation[][] = stationPositions.map((list, loop) =>
    list.map((s, index) => ({
      id: 'L' + (loop + 1) + '-ST' + String(index + 1).padStart(2, '0'),
      loopId: (loop + 1) as 1 | 2,
      s,
      bay: '',
      bayName: '',
      bayNameZh: '',
    })),
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
  const cableMaterial = new StandardMaterial('native-oht-cable', scene);
  cableMaterial.diffuseColor = color('#94a3b8');
  cableMaterial.emissiveColor = color('#94a3b8').scale(0.2);

  const cars: {
    body: ReturnType<typeof MeshBuilder.CreateBox>;
    arc: ArcPath;
    loop: number;
    index: number;
    id: number;
    led: StandardMaterial;
    ledHex: number;
    hoist: ReturnType<typeof MeshBuilder.CreateBox>;
    foup: ReturnType<typeof MeshBuilder.CreateBox>;
    cables: ReturnType<typeof MeshBuilder.CreateCylinder>[];
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
      foup.position.y = -0.7;
      foup.material = foupMaterial;
      foup.isVisible = false;
      foup.isPickable = false;
      const cables = [0, 1].map((side) => {
        const cable = MeshBuilder.CreateCylinder('native-oht-cable-' + loop + '-' + index + '-' + side, { diameter: 0.024, height: 0.5, tessellation: 6 }, scene);
        cable.parent = body;
        cable.position.set(side === 0 ? -0.25 : 0.25, -0.25, 0);
        cable.scaling.y = 0.5;
        cable.material = cableMaterial;
        cable.isPickable = false;
        return cable;
      });
      const shadow = MeshBuilder.CreateGround(`native-oht-shadow-${loop}-${index}`, { width: 2.4, height: 1.6 }, scene);
      shadow.parent = group;
      shadow.material = shadowMaterial;
      shadow.isPickable = false;
      cars.push({ body, arc: arcs[loop], loop, index, id: loop * 12 + index, led, ledHex: AMHS_LED_COLORS.IDLE, hoist, foup, cables, shadow });
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

  const traffic = createAmhsState({
    loops: {
      1: { length: arcs[0].total, stations: stations[0] },
      2: { length: arcs[1].total, stations: stations[1] },
    },
    initialNextTaskTime: 1.0,
    vehicles: [
      ...Array.from({ length: 12 }, (_, index) => ({ loopId: 1 as const, s: (index / 12) * arcs[0].total })),
      ...Array.from({ length: 12 }, (_, index) => ({ loopId: 2 as const, s: (index / 12) * arcs[1].total })),
    ],
  });
  const trafficRandom = createAmhsRandom(AMHS_TRAFFIC_SEED).random;
  const ledColors = new Map<number, Color3>();
  const ledColor = (hex: number) => {
    let tint = ledColors.get(hex);
    if (!tint) {
      tint = Color3.FromHexString('#' + hex.toString(16).padStart(6, '0'));
      ledColors.set(hex, tint);
    }
    return tint;
  };
  let statsTimer = 0;
  let lastTick = performance.now() / 1000;
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.12, Math.max(0.001, now - lastTick));
    lastTick = now;

    advanceAmhsState(traffic, dt, trafficRandom);

    for (const car of cars) {
      const vehicle = traffic.vehicles[car.id];
      const loopLength = traffic.loops[vehicle.loopId].length;
      const progress = ((vehicle.s / loopLength) % 1 + 1) % 1;
      const point = arcPoint(car.arc, progress);
      const ahead = arcPoint(car.arc, (progress + 0.002) % 1);
      car.body.position.set(point.x, 5.8, point.z);
      car.shadow.position.set(point.x + 1.15, 0.053, point.z + 1.3);
      const tangent = ahead.subtract(point).normalize();
      car.shadow.rotation.y = Math.atan2(tangent.x, tangent.z);
      if (car.body.rotationQuaternion) {
        Quaternion.FromUnitVectorsToRef(Vector3.Right(), tangent, car.body.rotationQuaternion);
      }
      car.hoist.position.y = -0.48 + vehicle.hoistY;
      car.foup.isVisible = vehicle.foupVisible;
      for (const cable of car.cables) {
        cable.scaling.y = vehicle.cableScaleY;
        cable.position.y = vehicle.cableY - 5.8;
      }
      if (car.ledHex !== vehicle.ledHex) {
        car.ledHex = vehicle.ledHex;
        const tint = ledColor(vehicle.ledHex);
        car.led.emissiveColor = tint;
        car.led.diffuseColor = tint;
      }
    }

    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = 0.5;
      const active = traffic.vehicles.filter((vehicle) => vehicle.state !== 'IDLE').length;
      onStats?.({
        active,
        total: traffic.vehicles.length,
        queued: traffic.queue.length,
        completed: traffic.completed.length,
        avgDelivery: traffic.completed.length > 0 ? traffic.totalDeliveryTime / traffic.completed.length : null,
      });
    }
  });
  return group;
}

export type LegacyLayer = 'amhs' | 'ceiling' | 'roof' | 'subfab' | 'heatmap' | 'airflow' | 'xray';

export interface LegacyRuntime {
  setLayer(layer: LegacyLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setExplodeFactor(factor: number, modeActive?: boolean): void;
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
  const personnelTimeline = createPersonnelTimeline({
    seed: 42, dt: 0.016, clockStartMs: 0, clockMsPerTick: 16,
    ticks: 0, chamberUserDataMode: 'as-built',
  });
  const roofParent = new TransformNode('roof-hvac-parent', scene);
  const roofHvac = buildOriginalRoofHvac(scene, roofParent);
  const architectureParent = new TransformNode('facility-architecture-parent', scene);
  const architecture = buildOriginalFacilityArchitecture(scene, architectureParent);
  architecture.setVisible(true);
  architecture.setCeilingVisible(false);
  fab.applyPersonnelFrame(personnelTimeline.readInitialFrame());
  architecture.applyAirShowerFrames(personnelTimeline.readInitialFrame().airShowers);
  let personnelRemainder = 0;
  scene.onBeforeRenderObservable.add(() => {
    // Fixed 16 ms logical source clock; cap catch-up after tab resume.
    personnelRemainder = Math.min(0.128,
      personnelRemainder + Math.max(0, scene.getEngine().getDeltaTime() / 1000));
    let steps = 0;
    while (personnelRemainder >= 0.016 && steps < 8) {
      personnelTimeline.step();
      personnelRemainder -= 0.016;
      steps++;
    }
    const frame = personnelTimeline.readFrame();
    fab.applyPersonnelFrame(frame);
    architecture.applyAirShowerFrames(frame.airShowers);
  });
  // Read-only diagnostics for `?perf` acceptance runs; product UI never reads this.
  const perfDiagnostics = new URLSearchParams(location.search).has('perf') ? { personnelTimeline } : {};
  const subfabParent = new TransformNode('subfab-facilities-parent', scene);
  const subfabDense = buildOriginalSubfabFacilities(scene, subfabParent);
  subfabDense.setVisible(false);
  const explodedLinks = buildOriginalExplodedLinks(scene);
  // Replace the early procedural air-shower approximation with the source airlocks.
  for (const mesh of scene.meshes) if (mesh.name.startsWith('airshower-')) mesh.setEnabled(false);
  scene.onBeforeRenderObservable.add(() => { const now = performance.now(); roofHvac.update(now); architecture.update(now); });
  // Original PBR surfaces already receive scene.ambientColor. A hemispheric
  // light here would add a second ambient term (most obvious on floor/columns).
  ambient.excludedMeshes = scene.meshes.filter(mesh => mesh.material instanceof PBRMaterial);
  fab.ceiling.setEnabled(false);
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
  const staticCasters = [fab.equipment, fab.shell, fab.subfab, roofHvac.group, subfabDense.group]
    .flatMap(root => root.getChildMeshes())
    .filter(mesh => mesh !== fab.floor && !mesh.name.startsWith('procedural-slab') && !mesh.name.startsWith('status-') && mesh.metadata?.staticShadowCaster !== false);
  const shadows = createNativeStaticShadows(scene, scene.getEngine() as WebGPUEngine, keyLight,
    () => staticCasters);
  scene.metadata = { ...scene.metadata, staticShadows: shadows, ...perfDiagnostics };
  const layerVisibility = { ceiling: false, roof: false, subfab: false, amhs: true, heatmap: false, airflow: false };
  let basementActive = false;
  let dualActive = false;
  let explodeFactor = 0;
  let targetExplodeFactor = 0;
  let explodeModeActive = false;
  let xrayFilter: XRayFilter | null = null;
  const isSystemMesh = (mesh: AbstractMesh, filter: XRayFilter): boolean => {
    const name = mesh.name.toLowerCase();
    if (filter === 'amhs') return name.includes('oht') || name.includes('amhs');
    if (!name.startsWith('subfab-')) return false;
    if (filter === 'upw') return name.includes('upw');
    if (filter === 'gas') return name.includes('gas');
    if (filter === 'vac') return name.includes('vac') || name.includes('pump') || name.includes('booster');
    return name.includes('foreline') || name.includes('heated') || name.includes('exhaust');
  };
  // ONE WGSL program drives every X-Ray surface. Triangle meshes are swapped onto palette
  // materials; the catalog wire meshes keep the same program permanently (LineListDrawMode) and
  // only switch uniforms, so there is no alpha/colour mutation fallback path.
  const xrayPalette = new XrayMaterialPalette(scene);
  const xrayLineMeshes = scene.meshes.filter((mesh) => mesh.name.endsWith('-wire'));
  for (const mesh of xrayLineMeshes) mesh.material = xrayPalette.line;
  const xrayEquipment = fab.equipment.getChildMeshes().filter((mesh) => !mesh.name.endsWith('-wire'));
  const xrayFloor = scene.meshes.filter((mesh) => mesh.material?.name === 'procedural-floor-material');
  const xraySubfab = [...fab.subfab.getChildMeshes(), ...subfabDense.group.getChildMeshes()];
  const xrayOht = amhsGroup.getChildMeshes().filter((mesh) => !mesh.name.includes('-shadow'));
  type XrayMeshSave = { material: Material | null; xrayCaster?: boolean };
  const xraySavedMaterials = new Map<AbstractMesh, XrayMeshSave>();
  const applyXrayMaterial = (mesh: AbstractMesh, role: XraySurfaceRole, matched = true) => {
    let saved = xraySavedMaterials.get(mesh);
    if (!saved) {
      saved = { material: mesh.material, xrayCaster: (mesh.metadata as { xrayCaster?: boolean } | null)?.xrayCaster };
      xraySavedMaterials.set(mesh, saved);
    }
    mesh.material = xrayPalette.meshMaterial(xraySurfaceState(role, xrayFilter as XRayFilter, matched));
    mesh.metadata = { ...mesh.metadata, xrayCaster: true };
  };
  const updateXrayFrame = () => {
    const time = performance.now() / 1000;
    xrayPalette.updateCamera(time);
    // Native static depth is sampled by the same hologram program; rebinding survives device loss.
    xrayPalette.updateShadow(shadows.matrix, shadows.texture, shadows.enabled && shadows.readyForCurrentDevice);
  };
  scene.onBeforeRenderObservable.add(() => {
    if (xrayFilter !== null) updateXrayFrame();
  });
  const restoreXRay = () => {
    for (const [mesh, saved] of xraySavedMaterials) {
      mesh.material = saved.material;
      const metadata = (mesh.metadata ?? {}) as Record<string, unknown>;
      if (saved.xrayCaster === undefined) delete metadata.xrayCaster;
      else metadata.xrayCaster = saved.xrayCaster;
      mesh.metadata = metadata;
    }
    xraySavedMaterials.clear();
    xrayPalette.setLineXray(false);
    xrayPalette.updateShadow(shadows.matrix, shadows.texture, false);
    if (xrayFilter !== null) {
      const keepVisible = explodeModeActive || explodeFactor > 0.01 || targetExplodeFactor > 0.01 || basementActive || dualActive;
      fab.subfab.setEnabled(keepVisible || layerVisibility.subfab);
      subfabDense.setVisible(keepVisible);
      shadows.invalidate('xray-visibility');
    }
    xrayFilter = null;
  };
  const applyXRay = (filter: XRayFilter | null) => {
    restoreXRay();
    if (!filter) return;
    xrayFilter = filter;
    for (const mesh of xrayEquipment) applyXrayMaterial(mesh, 'equipment');
    for (const mesh of xrayFloor) applyXrayMaterial(mesh, 'floor');
    for (const mesh of xraySubfab) applyXrayMaterial(mesh, 'subfab', filter === 'all' || isSystemMesh(mesh, filter));
    for (const mesh of xrayOht) applyXrayMaterial(mesh, 'oht');
    // The source X-Ray forces subfab piping visible and highlights/filters it; no mesh is hidden.
    fab.subfab.setEnabled(true);
    subfabDense.setVisible(true);
    xrayPalette.setLineXray(true);
    updateXrayFrame();
    shadows.invalidate('xray-visibility');
  };
  const applyExplodeFactor = (factor: number, modeActive?: boolean) => {
    targetExplodeFactor = Math.max(0, Math.min(1, Number.isFinite(factor) ? factor : 0));
    explodeModeActive = modeActive ?? targetExplodeFactor > 0;
  };
  const syncLevel = () => {
    const exploded = explodeModeActive || explodeFactor > 0.01 || targetExplodeFactor > 0.01;
    const cutaway = basementActive || dualActive;
    // Source floor remains visible with level-specific translucent states.
    const opacity = originalFloorOpacity(exploded ? 'EXPLODED'
      : basementActive ? 'B1' : dualActive ? 'DUAL' : 'L1');
    const floorMaterial = fab.floor.material;
    if (floorMaterial instanceof PBRMaterial) {
      floorMaterial.alpha = opacity;
      floorMaterial.disableDepthWrite = opacity < 1;
      floorMaterial.transparencyMode = opacity < 1
        ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    }
    fab.floor.setEnabled(true);
    fab.shell.setEnabled(!basementActive);
    fab.subfab.setEnabled(exploded || basementActive || dualActive || layerVisibility.subfab || xrayFilter !== null);
    fab.equipment.setEnabled(exploded || !basementActive);
    fab.personnel.setEnabled(!basementActive);
    architecture.setVisible(!basementActive);
    architecture.setCeilingVisible(exploded || (!basementActive && !dualActive && layerVisibility.ceiling));
    roofHvac.setVisible(layerVisibility.roof && !basementActive && !dualActive);
    subfabDense.setVisible(exploded || basementActive || dualActive || xrayFilter !== null);
    amhsGroup.setEnabled(!basementActive && layerVisibility.amhs);
    heatmap.group.setEnabled(!basementActive && layerVisibility.heatmap);
    airflow.group.setEnabled(!basementActive && layerVisibility.airflow);
    for (const mesh of scene.meshes) {
      if (/^(procedural-slab|native-zone|native-zone-border|native-floor-grid|zone-label|perimeter-wall|perimeter-glass|perimeter-kick|perimeter-door|native-oht-shadow|operator-ground-shadow|procedural-shadow-ground)/.test(mesh.name)) {
        mesh.setEnabled(!cutaway);
      }
    }
  };

  // Original exploded hierarchy animates at 0.08 of the remaining delta per frame.
  scene.onBeforeRenderObservable.add(() => {
    const previousVisible = explodeModeActive || explodeFactor > 0.01 || targetExplodeFactor > 0.01;
    const next = advanceExplodeFactor(explodeFactor, targetExplodeFactor);
    if (next === explodeFactor) return;
    explodeFactor = next;
    const placement = explodedPlacement(explodeFactor);
    architecture.ceilingGroup.position.y = placement.ceilingY;
    fab.subfab.position.y = placement.subfabY;
    subfabDense.group.position.y = placement.subfabY;
    const visibleNow = explodeModeActive || explodeFactor > 0.01 || targetExplodeFactor > 0.01;
    // Avoid traversing thousands of meshes on every easing frame.
    if (previousVisible !== visibleNow) syncLevel();
    explodedLinks.setFactor(explodeFactor);
    shadows.invalidate('exploded-hierarchy');
  });
  // The original animates interconnect rings even after the eased factor settles.
  scene.onBeforeRenderObservable.add(() => explodedLinks.update(performance.now()));

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
      if (layer === 'ceiling') {
        layerVisibility.ceiling = visible;
        architecture.setCeilingVisible(explodeModeActive || targetExplodeFactor > 0.01 || explodeFactor > 0.01 || (visible && !basementActive && !dualActive));
        shadows.invalidate('ceiling-visibility');
        return;
      }
      layerVisibility.subfab = visible;
      const exploded = explodeModeActive || targetExplodeFactor > 0.01 || explodeFactor > 0.01;
      fab.subfab.setEnabled(visible || basementActive || dualActive || exploded || xrayFilter !== null);
      subfabDense.setVisible(exploded || basementActive || dualActive || xrayFilter !== null);
      shadows.invalidate('layer-visibility');
    },
    setToolState(index, state) {
      statusLights.setState(index, state);
    },
    setExplodeFactor(factor, modeActive) {
      applyExplodeFactor(factor, modeActive);
      syncLevel();
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
      architecture.setLanguage(language);
      fab.setPersonnelLanguage(language);
    },
  };
}
