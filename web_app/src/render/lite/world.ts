import {
  attachControl, enableMaterialPlugins, enableMirroredMeshes, enableSurfaceResizeObserver,
  forceWebGpuDeviceLossForTesting, getMeshIndexedDrawInfo, getShaderTexture, getViewProjectionMatrix,
  isShaderMaterial, onBeforeRender, onEngineGpuError, rebuildSceneRenderables, setCameraLimits, setSubtreeVisible,
  resizeEngine,
  type ArcRotateCamera, type EngineContext, type Mesh, type SceneContext, type SceneNode,
} from '@babylonjs/lite';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '../../fab-layout';
import { advanceExplodeFactor, explodedPlacement } from '../../twin-spatial';
import type { AmhsStats, CutAxis, HoveredTool, PickedTool, SceneLayer, SceneViewPreset, XRayFilter } from '../../fab-scene';
import { createLiteCamera } from './camera';
import { createLiteCutPlane } from './cut-plane';
import { createLiteEffects } from './effects';
import { createLiteEnvironment } from './environment';
import { createLiteEquipment } from './geometry/tool-families';
import { createLiteFacility } from './geometry/facility';
import { createLiteStaticStructure, prepareStaticStructureEnvironment } from './geometry/static-structure';
import { createLiteLighting } from './lighting';
import { createLiteMotion } from './motion';
import { createNextReferenceCamera, attachNextCoordinateFrame } from './next-coordinate-frame';
import { createLiteSelection } from './selection';
import { createLiteShadows, selectLiteShadowCasters } from './shadows/native-lite-shadow';
import { createLiteToolStates } from './tool-states';

type Point = readonly [number, number, number];
export interface LiteWorldCallbacks {
  onAmhsStats?(stats: AmhsStats): void;
  onToolPick?(tool: PickedTool | null): void;
  onToolHover?(hover: HoveredTool | null): void;
  /** Latest Redux tool-state snapshot, read once per rendered frame like the legacy backend. */
  getToolStates?(): readonly FabToolState[];
}
export interface LiteWorldPerf {
  readonly frames: number;
  readonly fps: number;
  readonly drawCalls: number;
  readonly gpuFrameTimeMs: number;
  readonly meshes: number;
  readonly cameraPose: { position: Point; target: Point } | null;
  readonly shadows: { enabled: boolean; casters: number };
  readonly layers: Record<SceneLayer, boolean>;
  readonly level: 'L1' | 'B1' | 'DUAL' | 'EXPLODED';
  readonly explodeFactor: number;
  readonly xrayFilter: XRayFilter | null;
  readonly toolStates: readonly FabToolState[];
}
/** Read-only acceptance diagnostics: computed from live native objects, never cached. */
export interface LiteWorldDiagnostics {
  readonly gpuErrors: readonly string[];
  readonly recoveryPreparations: number;
  readonly cutPlane: readonly [number, number, number, number] | null;
  readonly selection: { readonly index: number | null; readonly visible: boolean; readonly center: Point | null; readonly scale: Point | null;
    readonly pickingEnabled: boolean; readonly pickStats: { readonly requests: number; readonly hits: number;
      readonly fails: number; readonly lastHit: boolean | null; readonly lastThinInstance: number | null; readonly lastError: string | null } };
  readonly wafer: { readonly markerVisible: boolean; readonly position: Point; readonly rotationY: number;
    readonly lightIntensity: number; readonly trailVisible: boolean; readonly trailIndexCount: number };
  readonly xray: { readonly filter: XRayFilter | null; readonly shaderMeshes: number; readonly shadowLinked: boolean };
  readonly structure: { readonly floorAlpha: number; readonly slabVisible: boolean; readonly shellVisible: boolean;
    readonly b1Visible: boolean; readonly b1Offset: number; readonly shellOffset: number };
  readonly facility: { readonly ceilingVisible: boolean; readonly ceilingOffset: number };
  readonly environment: { readonly roofVisible: boolean; readonly airflowVisible: boolean; readonly heatmapVisible: boolean;
    readonly linksVisible: boolean; readonly roofParticles: number; readonly airflowParticles: number;
    readonly labels: number; readonly airflowClock: number; readonly heatmapUpdates: number };
  readonly motion: { readonly stats: AmhsStats; readonly amhsVisible: boolean; readonly simTime: number;
    readonly patrol: Point; readonly vehicles: readonly { readonly x: number; readonly y: number; readonly z: number;
      readonly visible: boolean; readonly foup: boolean }[] };
  readonly toolStates: readonly FabToolState[];
  readonly shadowCasters: number;
  readonly meshCount: number;
  readonly shaderMaterials: readonly { readonly name: string; readonly meshes: number; readonly missingSamplers: readonly string[] }[];
}
export interface LiteWorld {
  readonly scene: SceneContext;
  readonly engine: EngineContext;
  readonly camera: ArcRotateCamera;
  /** Runtime beforeStart: native overlay billboards must exist before the first product frame. */
  registerLabels(): Promise<void>;
  setView(preset: SceneViewPreset, fabId?: string): void;
  setCameraPose(position: Point, target: Point, durationMs: number): void;
  getCameraPose(): { position: Point; target: Point } | null;
  zoom(deltaY: number): void;
  stopCameraTransition(): void;
  setLayer(layer: SceneLayer, visible: boolean): void;
  selectTool(index: number, focus?: boolean): void;
  clearSelection(): void;
  setToolState(index: number, state: FabToolState): void;
  setExplodeFactor(factor: number, modeActive?: boolean): void;
  setBasement(active: boolean): void;
  setDual(active: boolean): void;
  setTour(active: boolean): void;
  setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void;
  setXRayFilter(filter: XRayFilter | null): void;
  setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void;
  setWaferTrail(points: readonly Point[]): void;
  focusPatrol(): void;
  setLanguage(language: 'zh' | 'en'): void;
  resize(): void;
  readPerf(): LiteWorldPerf;
  readDiagnostics(): LiteWorldDiagnostics;
  /** Screen-space CSS px of a tool's centre (for real-GPU pick acceptance); null when behind the camera. */
  projectTool(index: number): { x: number; y: number } | null;
  /** Test-only hook (only reachable through the ?perf bridge): simulate a real WebGPU device loss. */
  forceDeviceLoss(): void;
  prepareForDeviceRecovery(): void;
  dispose(): void;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
function meshesUnder(scene: SceneContext, root: SceneNode): Mesh[] {
  return scene.meshes.filter(mesh => {
    let node = mesh.parent as SceneNode | null;
    while (node) { if (node === root) return true; node = node.parent as SceneNode | null; }
    return false;
  });
}

/**
 * Product composition for the native Lite renderer: every source system (equipment, static FAB,
 * facility, lighting, shadows, motion, environment, effects) plus one frame loop and the level/layer
 * state machine from legacy-site.ts:syncLevel. Coordinates stay in Next's RH domain; the single
 * attachNextCoordinateFrame root reflects Z at the render boundary.
 */
export async function createLiteWorld(
  scene: SceneContext, engine: EngineContext, canvas: HTMLCanvasElement, callbacks: LiteWorldCallbacks = {},
): Promise<LiteWorld> {
  // Opt-in composition tracing: /twin?liteDebug=1 reports each native build stage to the console.
  const debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('liteDebug');
  const stage = (name: string) => { if (debug) console.info('[lite-world]', name, Math.round(performance.now())); };
  stage('create');
  const camera = createNextReferenceCamera('home');
  scene.camera = camera;
  scene.clearColor = { r: 0.945, g: 0.961, b: 0.976, a: 1 };
  const cameraControl = createLiteCamera(scene, camera);
  const detachControl = attachControl(camera, canvas, scene);
  const detachLimits = setCameraLimits(camera, {
    lowerBetaLimit: 0.001, upperBetaLimit: Math.PI / 2 - 0.03, lowerRadiusLimit: 4, upperRadiusLimit: 180,
  });
  // FabViewport owns wheel zoom through SceneFacade.zoom (one sensitivity for canvas + overlays);
  // the native wheel handler must contribute nothing.
  camera.wheelPrecision = Number.POSITIVE_INFINITY;
  const detachResize = enableSurfaceResizeObserver(engine);

  const fabTarget: Point = [0, 1, 0];
  const toolStateCache: FabToolState[] = [...FAB_TOOL_STATES];
  const layers: Record<SceneLayer, boolean> = {
    amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false,
  };
  let basement = false, dual = false, xrayFilter: XRayFilter | null = null;
  let explodeFactor = 0, targetExplodeFactor = 0, explodeModeActive = false;
  let language: 'zh' | 'en' = 'zh';
  let disposed = false;
  let frames = 0, fpsFrames = 0, fpsSince = performance.now(), fps = 0;
  const gpuErrors: string[] = [];
  let recoveryPreparations = 0;

  let equipment: ReturnType<typeof createLiteEquipment> | undefined;
  let structure: ReturnType<typeof createLiteStaticStructure> | undefined;
  let facility: ReturnType<typeof createLiteFacility> | undefined;
  let motion: ReturnType<typeof createLiteMotion> | undefined;
  let environment: ReturnType<typeof createLiteEnvironment> | undefined;
  let effects: ReturnType<typeof createLiteEffects> | undefined;
  let lighting: ReturnType<typeof createLiteLighting> | undefined;
  let shadows: Awaited<ReturnType<typeof createLiteShadows>> | undefined;
  let toolStates: ReturnType<typeof createLiteToolStates> | undefined;
  let selection: ReturnType<typeof createLiteSelection> | undefined;
  const cutPlane = createLiteCutPlane();
  let detachSelection: (() => void) | undefined;
  let detachGpuError: (() => void) | undefined;

  const explodedNow = () => explodeModeActive || explodeFactor > 0.01 || targetExplodeFactor > 0.01;
  const currentLevel = (): 'L1' | 'B1' | 'DUAL' | 'EXPLODED' =>
    explodedNow() ? 'EXPLODED' : basement ? 'B1' : dual ? 'DUAL' : 'L1';

  function applyLevel() {
    if (!structure) return;
    // The floor alpha/slab/B1 visibility contract is shared with the preview (originalFloorOpacity).
    void structure.setLevel(currentLevel());
    structure.setOffset('b1', explodedNow() ? explodedPlacement(explodeFactor).subfabY : 0);
  }
  let allCasters: Mesh[] = [];
  function refreshCasters(b1Visible: boolean, roofVisible: boolean) {
    if (!shadows || !structure || !equipment) return;
    const b1 = new Set<Mesh>(), shell = new Set<Mesh>();
    for (const part of structure.parts) (part.layer === 'b1' ? b1 : shell).add(part.mesh);
    const roof = new Set(environment ? meshesUnder(scene, environment.roofRoot) : []);
    const equipmentMeshes = new Set(equipment.batches.map(batch => batch.mesh));
    const candidates = allCasters.filter(mesh => b1.has(mesh) || shell.has(mesh) || roof.has(mesh) || equipmentMeshes.has(mesh));
    const visible = candidates.filter(mesh => {
      if (b1.has(mesh)) return b1Visible;
      if (roof.has(mesh)) return roofVisible;
      return true;
    });
    shadows.setCasters(selectLiteShadowCasters(visible));
  }
  function applyVisibility() {
    if (!structure || !facility || !motion || !environment) return;
    const exploded = explodedNow(), xray = xrayFilter !== null;
    const b1Visible = exploded || basement || dual || layers.subfab || xray;
    structure.setVisible('shell', true);
    // Source permanently disables the early procedural ceiling; FFU view uses the restored facility deck.
    structure.setVisible('ffu', false);
    structure.setVisible('b1', b1Visible);
    facility.setCeilingVisible(exploded || layers.ceiling);
    facility.ceiling.position.y = exploded ? explodedPlacement(explodeFactor).ceilingY : 0;
    setSubtreeVisible(motion.amhsRoot, layers.amhs);
    environment.setLayer('roof', layers.roof);
    environment.setLayer('heatmap', layers.heatmap && !basement);
    environment.setLayer('airflow', layers.airflow && !basement);
    environment.setExplodeFactor(explodeFactor);
    // X-Ray forces the subfab visible and hides the slab in the source; level switching owns the rest.
    const slab = structure.parts.find(part => part.name === 'procedural-slab');
    if (slab) setSubtreeVisible(slab.mesh, currentLevel() === 'L1' && !xray);
    // Legacy babylon-webgpu.ts:findToolAt early-outs while the B1 level is active.
    selection?.setPickingEnabled(!basement);
    refreshCasters(b1Visible, layers.roof);
  }
  function syncState() {
    if (disposed) return;
    applyLevel();
    applyVisibility();
  }

  try {
    stage('equipment');
    equipment = createLiteEquipment(scene, engine);
    stage('structure');
    structure = createLiteStaticStructure(scene, engine);
    stage('motion');
    motion = createLiteMotion(scene, engine);
    stage('facility');
    facility = createLiteFacility(scene, engine, { frames: () => motion!.readAirShowerFrames() });
    stage('environment');
    environment = createLiteEnvironment(scene, engine);
    stage('effects');
    effects = createLiteEffects(scene, engine, { sampledDepthFallback: true });
    stage('tool-states');
    toolStates = createLiteToolStates(scene, engine, equipment);
    toolStates.applyAll(toolStateCache);
    stage('selection');
    selection = createLiteSelection(scene, engine, {
      equipment,
      getToolState: index => toolStateCache[index] ?? 'running',
      hoverPickMs: Math.max(0, Number(new URLSearchParams(location.search).get('hoverPickMs') ?? '50') || 0),
    });
    detachGpuError = onEngineGpuError(engine, error => gpuErrors.push(error.message));
    lighting = createLiteLighting(scene, [...structure.lights, ...facility.lights]);
    const frameNodes: SceneNode[] = [
      ...equipment.batches.map(batch => batch.mesh),
      ...Object.values(structure.roots), structure.lightRoot,
      facility.root, motion.root, environment.root, effects.root, lighting.root,
    ];
    if (selection.root) frameNodes.push(selection.root);
    stage('coordinate-frame');
    attachNextCoordinateFrame(frameNodes);
    // Section cut must clip every native PBR/Standard FAB material: attach the public
    // MaterialPlugin pair before enableMaterialPlugins bakes the scene pipelines.
    // PBR-only: see cut-plane.ts (Standard plugin UBO is not native-recovery safe in Lite 1.36).
    cutPlane.attach(scene.meshes, { standard: false });
    stage('lighting-materials');
    lighting.configureMaterials(scene.meshes);
    enableMaterialPlugins(scene);
    stage('mirrored-meshes');
    await enableMirroredMeshes(scene);
    stage('environment-ibl');
    await prepareStaticStructureEnvironment(scene);
    stage('shadows');
    shadows = await createLiteShadows(scene, engine, lighting.key);
    stage('xray-targets');
    // NOTE: Lite 1.36 rejects CSM-refit frames in which a ShaderMaterial samples the receiver
    // depth texture being re-rendered (WebGPU usage conflict). The product X-Ray palette therefore
    // does not borrow the CSM depth; native PBR/Standard surfaces keep full shadows (FEATURE_GAPS).
    void effects; // effects.shadowLinked stays false; shadows.generator remains native-owned.
    allCasters = unique([
      ...equipment.batches.map(batch => batch.mesh),
      ...structure.parts.filter(part => part.layer !== 'ffu').map(part => part.mesh),
      ...meshesUnder(scene, environment.roofRoot),
    ]);
    const b1Meshes = unique(structure.parts.filter(part => part.layer === 'b1').map(part => part.mesh));
    const floorMesh = structure.parts.find(part => part.name === 'procedural-floor')?.mesh;
    const amhsMeshes = meshesUnder(scene, motion.amhsRoot);
    effects.configureXrayTargets([
      ...equipment.batches.map(batch => ({ mesh: batch.mesh, role: 'equipment' as const })),
      ...(floorMesh ? [{ mesh: floorMesh, role: 'floor' as const }] : []),
      ...b1Meshes.map(mesh => ({ mesh, role: 'subfab' as const })),
      ...amhsMeshes.map(mesh => ({ mesh, role: 'oht' as const })),
    ]);
    detachSelection = selection.bind(canvas, {
      onPick: tool => callbacks.onToolPick?.(tool),
      onHover: hover => callbacks.onToolHover?.(hover),
      // Legacy onDoubleClick -> selectToolByIndex(index, true): focus camera on the tool.
      onSelectFocus: index => {
        const tool = FAB_LAYOUT[index];
        if (tool) cameraControl.focus([tool.x, Math.min(1.5, tool.height / 2), tool.z], Math.PI / 3.6, 58, 520);
      },
    });
    // Source initial state: architecture loaded but ceiling/roof/subfab hidden, AMHS visible.
    facility.update();
    syncState();
    onBeforeRender(scene, frame);
    stage('world-complete');
  } catch (error) {
    dispose();
    throw error;
  }

  function syncToolStates() {
    const next = callbacks.getToolStates?.();
    if (!next || !toolStates) return;
    for (let index = 0; index < next.length && index < toolStateCache.length; index += 1) {
      const state = next[index];
      if (state === toolStateCache[index]) continue;
      toolStateCache[index] = state;
      toolStates.setToolState(index, state);
    }
  }
  function frame(deltaMs: number) {
    if (disposed || !motion || !environment || !facility || !effects || !toolStates) return;
    const now = performance.now();
    motion.update(deltaMs, now);
    environment.update(deltaMs, now);
    // Shared personnel clock: the air-shower animation follows the motion module's frame.
    facility.update();
    effects.update(deltaMs, now);
    toolStates.update(deltaMs, now);
    syncToolStates();
    const next = advanceExplodeFactor(explodeFactor, targetExplodeFactor);
    if (next !== explodeFactor) {
      const wasExploded = explodedNow();
      explodeFactor = next;
      environment.setExplodeFactor(explodeFactor);
      if (facility) facility.ceiling.position.y = explodedPlacement(explodeFactor).ceilingY;
      if (structure) structure.setOffset('b1', explodedPlacement(explodeFactor).subfabY);
      // Crossing the exploded threshold changes floor alpha/slab/ceiling too, not only layer visibility.
      if (wasExploded !== explodedNow()) syncState();
    }
    callbacks.onAmhsStats?.(motion.readStats());
    frames += 1; fpsFrames += 1;
    const measuredAt = performance.now();
    if (measuredAt - fpsSince >= 1000) {
      fps = fpsFrames * 1000 / (measuredAt - fpsSince);
      fpsFrames = 0; fpsSince = measuredAt;
    }
  }

  function setXRayFilter(filter: XRayFilter | null) {
    const wasActive = xrayFilter !== null;
    xrayFilter = filter;
    layers.xray = filter !== null;
    effects?.setXRayFilter(filter);
    applyVisibility();
    // Leaving X-Ray leaves the palette ShaderMaterial group empty. Lite 1.36 native scene
    // recovery rebuilds every recorded group without skipping empty ones, so reconcile the
    // groups now (public rebuild API) instead of leaving an empty shader group for recovery.
    if (wasActive && filter === null) {
      void rebuildSceneRenderables(scene).catch(error => console.error('[lite] xray group reconcile failed', error));
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    detachSelection?.();
    detachGpuError?.();
    cutPlane.dispose();
    effects?.dispose();
    selection?.dispose();
    toolStates?.dispose();
    environment?.dispose();
    facility?.dispose();
    motion?.dispose();
    lighting?.dispose();
    structure?.dispose();
    cameraControl.dispose();
    detachControl();
    detachLimits();
    detachResize();
  }

  return {
    scene, engine, camera,
    registerLabels: async () => {
      if (disposed) return;
      await Promise.all([facility?.registerLabels(), environment?.registerBillboards()]);

    },
    setView(preset, fabId) {
      if (disposed) return;
      // Single-FAB product layout: every fabId focuses the same source target (legacy fabTargets map).
      const focus = fabId ? fabTarget : undefined;
      if ((preset === 'focus' || preset === 'iso') && focus) cameraControl.preset(preset, 1000, focus);
      else cameraControl.preset(preset, 1000);
    },
    setCameraPose(position, target, durationMs) { if (!disposed) cameraControl.setPose(position, target, durationMs); },
    getCameraPose() { return disposed ? null : cameraControl.readPose(); },
    zoom(deltaY) { if (!disposed) cameraControl.zoom(deltaY); },
    stopCameraTransition() { cameraControl.cancel(); },
    setLayer(layer, visible) {
      if (disposed) return;
      if (layer === 'xray') { setXRayFilter(visible ? xrayFilter ?? 'all' : null); return; }
      layers[layer] = visible;
      applyVisibility();
    },
    selectTool(index, focus) {
      if (disposed || !selection) return;
      const pose = selection.selectTool(index, focus);
      if (pose && focus) cameraControl.focus(pose.target, Math.PI / 3.6, 58, 520);
    },
    clearSelection() { selection?.clear(); },
    setToolState(index, state) {
      if (disposed || index < 0 || index >= toolStateCache.length) return;
      toolStateCache[index] = state;
      toolStates?.setToolState(index, state);
    },
    setExplodeFactor(factor, modeActive) {
      if (disposed) return;
      targetExplodeFactor = Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : 0;
      explodeModeActive = modeActive ?? targetExplodeFactor > 0;
      // Legacy setExplodeFactor refreshes the selection box against the new hierarchy bounds.
      selection?.refresh();
      syncState();
    },
    setBasement(active) {
      if (disposed) return;
      basement = active;
      if (active) dual = false;
      if (active) selection?.clear();
      syncState();
    },
    setDual(active) {
      if (disposed) return;
      dual = active;
      if (active) basement = false;
      if (active) selection?.clear();
      syncState();
    },
    setTour(active) { if (active) cameraControl.cancel(); },
    setCutPlane(active, axis, position, invert) {
      if (disposed || !effects) return;
      if (active) selection?.clear();
      // The effects shaders and the native material plugin must clip the same half-space.
      effects.setCutPlane(active, axis, position, invert);
      cutPlane.setPlane(active, axis, position, invert);
    },
    setXRayFilter(filter) { if (!disposed) setXRayFilter(filter); },
    setWaferPoint(x, y, z, visible, focus, rotationY) {
      if (disposed || !effects) return;
      effects.setWaferPoint(x, y, z, visible, focus, rotationY);
      if (visible && focus) {
        cameraControl.cancel();
        camera.target.x = x; camera.target.y = y; camera.target.z = -z;
        camera.alpha = -Math.PI / 2; camera.beta = Math.acos(0.6); camera.radius = 10;
      }
    },
    setWaferTrail(points) { if (!disposed) effects?.setWaferTrail(points); },
    focusPatrol() {
      if (disposed || !motion) return;
      const position = motion.patrolPosition();
      cameraControl.focus([position[0], 1.2, position[2]], 1.08, 18, 0);
    },
    setLanguage(next) {
      if (disposed || next === language) return;
      language = next;
      motion?.setLanguage(next);
      environment?.setLanguage(next);
      facility?.setLanguage(next);
    },
    resize() { if (!disposed) resizeEngine(engine); },
    projectTool(index: number) {
      const tool = FAB_LAYOUT[index];
      if (!tool || disposed) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      // Domain RH metres -> Lite render space (one Z reflection at the composition boundary).
      const x = tool.x, y = tool.height / 2, z = -tool.z;
      const m = getViewProjectionMatrix(camera, rect.width / rect.height);
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0) return null;
      return { x: rect.left + (cx / cw * 0.5 + 0.5) * rect.width,
        y: rect.top + (1 - (cy / cw * 0.5 + 0.5)) * rect.height };
    },
    forceDeviceLoss() { if (!disposed) forceWebGpuDeviceLossForTesting(engine); },
    readDiagnostics(): LiteWorldDiagnostics {
      const meshNamed = (name: string) => scene.meshes.find(mesh => mesh.name === name);
      const selectionMesh = meshNamed('tool-selection');
      const marker = meshNamed('wafer-follow-marker');
      const trail = meshNamed('wafer-follow-trail');
      const floor = structure?.parts.find(part => part.name === 'procedural-floor')?.mesh;
      const slab = structure?.parts.find(part => part.name === 'procedural-slab')?.mesh;
      const snapshot = motion?.readSnapshot();
      const patrol = motion?.patrolPosition() ?? [0, 0, 0];
      const floorMaterial = floor?.material as { alpha?: number } | undefined;
      const roots = structure?.roots;
      const xrayMeshes = scene.meshes.filter(mesh => {
        const name = (mesh.material as { name?: string } | null)?.name;
        return typeof name === 'string' && name.startsWith('fab-xray-');
      }).length;
      return {
        gpuErrors: [...gpuErrors],
        recoveryPreparations,
        cutPlane: scene.clipPlane ? [scene.clipPlane[0], scene.clipPlane[1], scene.clipPlane[2], scene.clipPlane[3]] : null,
        selection: {
          index: selection?.selectedIndex ?? null,
          visible: selectionMesh ? selectionMesh.visible !== false : false,
          center: selectionMesh ? [selectionMesh.position.x, selectionMesh.position.y, selectionMesh.position.z] : null,
          scale: selectionMesh ? [selectionMesh.scaling.x, selectionMesh.scaling.y, selectionMesh.scaling.z] : null,
          pickingEnabled: selection?.pickingEnabled ?? false,
          pickStats: selection?.stats ?? { requests: 0, hits: 0, fails: 0, lastHit: null, lastThinInstance: null, lastError: null },
        },
        wafer: {
          markerVisible: marker ? marker.visible !== false : false,
          position: marker ? [marker.position.x, marker.position.y, marker.position.z] : [0, 0, 0],
          rotationY: marker?.rotation.y ?? 0,
          lightIntensity: effects?.lights[0]?.intensity ?? 0,
          trailVisible: trail ? trail.visible !== false : false,
          trailIndexCount: trail ? getMeshIndexedDrawInfo(trail).indexCount ?? 0 : 0,
        },
        xray: { filter: xrayFilter, shaderMeshes: xrayMeshes, shadowLinked: effects?.shadowLinked ?? false },
        structure: {
          floorAlpha: floorMaterial?.alpha ?? 1,
          slabVisible: slab ? slab.visible !== false : false,
          shellVisible: roots ? roots.shell.visible !== false : false,
          b1Visible: roots ? roots.b1.visible !== false : false,
          b1Offset: roots?.b1.position.y ?? 0,
          shellOffset: roots?.shell.position.y ?? 0,
        },
        facility: {
          ceilingVisible: facility ? facility.ceiling.visible !== false : false,
          ceilingOffset: facility?.ceiling.position.y ?? 0,
        },
        environment: {
          roofVisible: environment ? environment.roofRoot.visible !== false : false,
          airflowVisible: environment ? environment.airflowRoot.visible !== false : false,
          heatmapVisible: environment ? environment.heatmapRoot.visible !== false : false,
          linksVisible: environment ? environment.linksRoot.visible !== false : false,
          roofParticles: environment?.diagnostics.roofParticles.length ?? 0,
          airflowParticles: environment?.diagnostics.airflowParticles.length ?? 0,
          labels: environment?.diagnostics.labels.length ?? 0,
          airflowClock: environment?.diagnostics.airflowClock ?? 0,
          heatmapUpdates: environment?.diagnostics.heatmapUpdates ?? 0,
        },
        motion: {
          stats: motion?.readStats() ?? { active: 0, total: 0, queued: 0, completed: 0, avgDelivery: null },
          amhsVisible: motion ? motion.amhsRoot.visible !== false : false,
          simTime: snapshot?.simTime ?? 0,
          patrol: [patrol[0], patrol[1], patrol[2]],
          vehicles: (motion?.readVehiclePositions() ?? []).map(vehicle => ({ x: vehicle.position[0],
            y: vehicle.position[1], z: vehicle.position[2], visible: vehicle.rotationY !== undefined,
            foup: vehicle.foupVisible })),
        },
        toolStates: [...toolStateCache],
        shadowCasters: shadows?.activeCasters.length ?? 0,
        meshCount: scene.meshes.length,
        shaderMaterials: (() => {
          const rows = new Map<string, { name: string; meshes: number; missingSamplers: string[] }>();
          for (const mesh of scene.meshes) {
            const material = mesh.material;
            if (!material || !isShaderMaterial(material)) continue;
            const materialName = String((material as { name?: string }).name ?? 'shader');
            const row = rows.get(materialName) ?? { name: materialName, meshes: 0, missingSamplers: [] as string[] };
            row.meshes += 1;
            for (const sampler of material.samplerDecls) {
              const samplerName = String(sampler.name);
              if (!getShaderTexture(material, samplerName) && !row.missingSamplers.includes(samplerName)) row.missingSamplers.push(samplerName);
            }
            rows.set(materialName, row);
          }
          return [...rows.values()];
        })(),
      };
    },
    readPerf(): LiteWorldPerf {
      return {
        frames, fps, drawCalls: engine.drawCallCount, gpuFrameTimeMs: engine.gpuFrameTimeMs,
        meshes: scene.meshes.length, cameraPose: disposed ? null : cameraControl.readPose(),
        shadows: { enabled: shadows?.enabled ?? false, casters: shadows?.activeCasters.length ?? 0 },
        layers: { ...layers }, level: currentLevel(), explodeFactor, xrayFilter,
        toolStates: [...toolStateCache],
      };
    },
    prepareForDeviceRecovery() {
      if (disposed) return;
      recoveryPreparations += 1;
      equipment?.prepareForDeviceRecovery();
      structure?.prepareForDeviceRecovery();
      facility?.prepareForDeviceRecovery();
      motion?.prepareForDeviceRecovery();
      environment?.prepareForDeviceRecovery();
      effects?.prepareForDeviceRecovery();
      toolStates?.prepareForDeviceRecovery();
      selection?.prepareForDeviceRecovery();
    },
    dispose,
  };
}
