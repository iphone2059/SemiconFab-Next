// Test-only entry: never imported by the application or its production build.
import {
  addToScene, attachControl, createArcRotateCamera, createBox,
  createHemisphericLight, createPbrMaterial, forceWebGpuDeviceLossForTesting,
  getRenderingContexts, getTextureMetadata, getTextureTransform, getMeshGeometry, getViewProjectionMatrix,
  onBeforeRender, onEngineGpuError, setSubtreeVisible, enableMirroredMeshes, enableMaterialPlugins, setLightIntensity,
  createStandardMaterial, setPbrUnlit,
  type ArcRotateCamera, type EngineContext, type SceneContext,
  type PbrMaterialProps,
} from '@babylonjs/lite';
import { createLiteRuntime, type LiteRuntime } from '../../src/rendering/lite/runtime';
import { createLiteEquipment, type LiteEquipment } from '../../src/rendering/lite/geometry/tool-families';
import { createLiteStaticStructure, prepareStaticStructureEnvironment, type LiteStaticStructure } from '../../src/rendering/lite/geometry/static-structure';
import { attachNextCoordinateFrame, createNextReferenceCamera, applyNextReferenceView } from '../../src/rendering/lite/next-coordinate-frame';
import { createLiteLighting } from '../../src/rendering/lite/lighting';
import { createLiteShadows } from '../../src/rendering/lite/shadows/native-lite-shadow';
import { createLiteFacility } from '../../src/rendering/lite/geometry/facility';

const canvas = document.querySelector('canvas')!;
const output = document.querySelector('output')!;
const states: string[] = [];
const gpuErrors: string[] = [];
let frames = 0;
let runtime: LiteRuntime | undefined;
let context: { engine: EngineContext; scene: SceneContext } | undefined;
const sceneKind = new URLSearchParams(location.search).get('scene');
const structureScene = sceneKind === 'structure';
const equipmentScene = sceneKind === 'equipment' || structureScene;
let equipment: LiteEquipment | undefined;
let structure: LiteStaticStructure | undefined;
let camera: ArcRotateCamera | undefined;
let lighting: ReturnType<typeof createLiteLighting> | undefined;
let shadows: Awaited<ReturnType<typeof createLiteShadows>> | undefined;
let facility: ReturnType<typeof createLiteFacility> | undefined;
let loadingStage = 'mount';

async function mount(abortImmediately = false) {
  runtime?.dispose();
  context = undefined;
  equipment = undefined;
  structure = undefined;
  lighting = undefined; shadows = undefined; facility = undefined;
  loadingStage = 'acquire';
  const controller = new AbortController();
  let mountedFacility: ReturnType<typeof createLiteFacility> | undefined;
  const next = createLiteRuntime(canvas, {
    signal: controller.signal,
    beforeStart: () => mountedFacility?.registerLabels(),
    async compose(scene, engine) {
      loadingStage = 'compose';
      // Track this generation at acquisition, including mounts aborted before ready resolves.
      context = { engine, scene };
      scene.clearColor = equipmentScene ? { r: 0.945, g: 0.961, b: 0.976, a: 1 } : { r: 0.86, g: 0.93, b: 0.99, a: 1 };
      camera = equipmentScene
        ? createNextReferenceCamera()
        : createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 0, y: 0, z: 0 });
      scene.camera = camera;
      const detachControl = attachControl(camera, canvas, scene);
      const detachErrors = onEngineGpuError(engine, error => gpuErrors.push(error.message));
      onBeforeRender(scene, () => { frames++; });
      if (sceneKind === 'lighting-probe') {
        lighting = createLiteLighting(scene, []);
        const unlit = createBox(engine, { size: 2 }); unlit.position.x = -1.8;
        unlit.material = createPbrMaterial({ baseColorFactor: [0.35, 0.45, 0.55, 1] });
        setPbrUnlit(unlit.material);
        const standard = createBox(engine, { size: 2 }); standard.position.x = 1.8;
        const standardMaterial = createStandardMaterial(); standardMaterial.diffuseColor = [0.5, 0.5, 0.5];
        standard.material = standardMaterial;
        addToScene(scene, unlit); addToScene(scene, standard);
        lighting.configureMaterials(scene.meshes); enableMaterialPlugins(scene);
        const mountedProbe = lighting;
        return () => { mountedProbe.dispose(); detachControl(); detachErrors(); };
      }
      if (!equipmentScene) addToScene(scene, createHemisphericLight([0, 1, 0], 1));
      let mountedStructure: LiteStaticStructure | undefined;
      let mountedLighting: ReturnType<typeof createLiteLighting> | undefined;
      try {
        if (equipmentScene) equipment = createLiteEquipment(scene, engine);
        else {
          const box = createBox(engine, { size: 2 });
          box.material = createPbrMaterial({ baseColorFactor: [0.2, 0.7, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.55 });
          addToScene(scene, box);
        }
        mountedStructure = structureScene ? createLiteStaticStructure(scene, engine) : undefined;
        structure = mountedStructure;
        mountedStructure?.setVisible('ffu', false);
        mountedStructure?.setVisible('b1', false);
        // The restored facility needs its own PBR plugin instance, so it joins the scene
        // before the source-light material pass runs.
        if (structureScene) { mountedFacility = createLiteFacility(scene, engine); facility = mountedFacility; }
        if (equipment) {
          mountedLighting = createLiteLighting(scene, [...(mountedStructure?.lights ?? []),
            ...(mountedFacility?.lights ?? [])]);
          lighting = mountedLighting;
          attachNextCoordinateFrame([...equipment.batches.map(batch => batch.mesh),
            ...(mountedStructure ? [...Object.values(mountedStructure.roots), mountedStructure.lightRoot] : []),
            ...(mountedFacility ? [mountedFacility.root] : []), mountedLighting.root]);
          mountedLighting.configureMaterials(scene.meshes);
          enableMaterialPlugins(scene);
          await enableMirroredMeshes(scene);
        }
        if (mountedStructure) {
          loadingStage = 'environment';
          await prepareStaticStructureEnvironment(scene);
          loadingStage = 'shadows';
          shadows = await createLiteShadows(scene, engine, mountedLighting!.key);
        }
        loadingStage = 'register';
        return () => { mountedFacility?.dispose(); mountedLighting?.dispose(); mountedStructure?.dispose();
          detachControl(); detachErrors(); };
      } catch (error) { mountedFacility?.dispose(); mountedLighting?.dispose(); mountedStructure?.dispose();
        detachControl(); detachErrors(); throw error; }
    },
    onStatus(status, error) {
      if (status === 'lost') { equipment?.prepareForDeviceRecovery(); structure?.prepareForDeviceRecovery();
        mountedFacility?.prepareForDeviceRecovery(); }
      states.push(status); output.textContent = `Lite ${structureScene ? 'P2 static FAB · 121 tools' : equipmentScene ? 'P2 equipment · 121 tools' : 'P1'} · ${status}`;
      if (error) gpuErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
    },
  });
  runtime = next;
  if (abortImmediately) controller.abort();
  try { context = await next.ready; }
  catch (error) { if (!controller.signal.aborted) throw error; }
  return snapshot();
}

function snapshot() {
  return {
    status: runtime?.status, loadingStage,
    states: [...states], gpuErrors: [...gpuErrors], frames,
    drawCalls: context?.engine.drawCallCount ?? 0,
    registeredContexts: context ? getRenderingContexts(context.engine).length : 0,
    surfaces: context?.engine.surfaces.length ?? 0,
    meshes: context?.scene.meshes.length ?? 0,
    lighting: lighting ? { keyIntensity: lighting.key.intensity, localLights: lighting.localLights.length,
      shadows: shadows?.enabled ?? false, casters: shadows?.casters.length ?? 0 } : undefined,
    width: canvas.width, height: canvas.height,
    equipment: equipment ? {
      tools: equipment.tools.length, batches: equipment.batches.length,
      visible: equipment.batches.every(batch => batch.mesh.visible !== false),
      instances: equipment.batches.reduce((sum, batch) => sum + (batch.mesh.thinInstances?.count ?? 0), 0),
      identities: equipment.tools.map(tool => ({ instanceId: tool.instanceId, recordId: tool.recordId,
        mapped: tool.parts.every(part => equipment!.resolve(equipment!.batches[part.batchIndex].mesh, part.instanceIndex) === tool) })),
    } : undefined,
    facility: facility ? {
      parts: facility.parts.length, meshes: facility.meshes.length, airShowers: facility.airShowers.length,
      lights: facility.lights.length, ceilingVisible: facility.ceiling.visible !== false,
      labels: facility.labels.length,
      instances: facility.meshes.reduce((sum, mesh) => sum + (mesh.thinInstances?.count ?? 0), 0),
    } : undefined,
    structure: structure ? {
      parts: structure.parts.length, batches: structure.batches.length, lights: structure.lights.length,
      airshowerVisible: structure.parts.filter(part => part.name.startsWith('airshower-'))
        .some(part => part.mesh.visible !== false),
      floorAlpha: (structure.parts.find(part => part.name === 'procedural-floor')!.mesh.material as PbrMaterialProps).alpha ?? 1,
      slabVisible: structure.parts.find(part => part.name === 'procedural-slab')!.mesh.visible !== false,
      layers: Object.fromEntries((['shell', 'ffu', 'b1'] as const).map(layer => [layer, {
        visible: structure!.roots[layer].visible !== false, offset: structure!.roots[layer].position.y,
        parts: structure!.parts.filter(part => part.layer === layer).length,
      }])),
      textures: [...new Set(structure.batches.map(mesh => (mesh.material as { baseColorTexture?: unknown }).baseColorTexture)
        .filter(Boolean))].map(texture => ({ metadata: getTextureMetadata(texture),
          transform: getTextureTransform(texture as Parameters<typeof getTextureTransform>[0]) })),
    } : undefined,
  };
}

const acceptance = {
  mount, snapshot,
  dispose() { runtime?.dispose(); return snapshot(); },
  loseDevice() { if (!context) throw new Error('Scene not ready'); forceWebGpuDeviceLossForTesting(context.engine); },
  setShadows(enabled: boolean) { if (!shadows) throw new Error('Shadows not ready'); shadows.setEnabled(enabled); },
  setKeyLight(enabled: boolean) { if (!lighting) throw new Error('Lights not ready'); setLightIntensity(lighting.key, enabled ? 1.15 : 0); },
  setFillLight(enabled: boolean) { if (!lighting) throw new Error('Lights not ready'); lighting.setFillEnabled(enabled); },
  setAmbientLight(enabled: boolean) { if (!lighting) throw new Error('Lights not ready'); lighting.setAmbientEnabled(enabled); },
  setLocalLights(enabled: boolean) { if (!lighting) throw new Error('Lights not ready'); lighting.setLocalLightsEnabled(enabled); },
  setFacilityCeiling(visible: boolean) { if (!facility) throw new Error('Facility not ready'); facility.setCeilingVisible(visible); },
  setLabelsVisible(visible: boolean) {
    if (!facility) throw new Error('Facility not ready');
    for (const label of facility.labels) label.system.visible = visible;
  },
  isoView() {
    if (!camera) throw new Error('Scene not ready');
    applyNextReferenceView(camera, 'iso');
  },
  topView() {
    if (!camera) throw new Error('Scene not ready');
    applyNextReferenceView(camera, 'top');
  },
  async structureView(view: 'l1' | 'b1' | 'dual' | 'ffu') {
    if (!structure || !equipment || !camera) throw new Error('Static scene not ready');
    // The source permanently disables the procedural ceiling (legacy-site.ts:412); the FFU
    // layer is the restored original ceiling owned by the facility module.
    structure.setVisible('ffu', false);
    facility?.setCeilingVisible(view === 'ffu');
    for (const batch of equipment.batches) setSubtreeVisible(batch.mesh, true);
    // Select the pose synchronously; an older material rebuild must not overwrite a newer click.
    if (view !== 'ffu') applyNextReferenceView(camera, view);
    await structure.setLevel(view === 'b1' ? 'B1' : view === 'dual' ? 'DUAL' : 'L1');
  },
  inspectLayout() {
    if (!context || !equipment || !camera) throw new Error('Scene not ready');
    const transform = (p: number[], m: ArrayLike<number>, offset = 0) => [0, 1, 2].map(axis =>
      m[offset + axis] * p[0] + m[offset + axis + 4] * p[1] + m[offset + axis + 8] * p[2] + m[offset + axis + 12]);
    const positions = new Map(equipment.batches.map(({ mesh }) => [mesh, getMeshGeometry(mesh)!.positions]));
    const bounds = (vertices: number[][]) => ({ min: [0, 1, 2].map(axis => Math.min(...vertices.map(p => p[axis]))),
      max: [0, 1, 2].map(axis => Math.max(...vertices.map(p => p[axis]))) });
    const tools = equipment.tools.map(tool => {
      const vertices: number[][] = [];
      for (const part of tool.parts) {
        const mesh = equipment!.batches[part.batchIndex].mesh;
        const data = positions.get(mesh)!;
        for (let i = 0; i < data.length; i += 3) vertices.push(transform(
          transform(Array.from(data.subarray(i, i + 3)), mesh.thinInstances!.matrices, part.instanceIndex * 16), mesh.worldMatrix));
      }
      return { instanceId: tool.instanceId, recordId: tool.recordId, vertices, bounds: bounds(vertices) };
    });
    const yellow = structure?.parts.filter(part => part.name === 'native-zone-0' || part.name.startsWith('original-amber-panel-'))
      .map(part => {
        const data = getMeshGeometry(part.mesh)!.positions;
        const vertices: number[][] = [];
        for (let i = 0; i < data.length; i += 3) {
          let p = Array.from(data.subarray(i, i + 3));
          if (part.mesh.thinInstances) p = transform(p, part.mesh.thinInstances.matrices, part.instanceIndex * 16);
          vertices.push(transform(p, part.mesh.worldMatrix));
        }
        return { name: part.name, vertices, bounds: bounds(vertices) };
      });
    return { tools, yellow, viewProjection: Array.from(getViewProjectionMatrix(camera, canvas.width / canvas.height)),
      camera: { position: [camera.worldMatrix[12], camera.worldMatrix[13], camera.worldMatrix[14]],
        target: [camera.target.x, camera.target.y, camera.target.z], fov: camera.fov },
      viewport: { width: canvas.width, height: canvas.height } };
  },
};
Object.assign(window, { __liteAcceptance: acceptance });
if (structureScene) {
  const controls = document.createElement('nav');
  controls.setAttribute('aria-label', 'Static scene layers');
  for (const [label, action] of [['ISO', acceptance.isoView], ['TOP', acceptance.topView]] as const) {
    const button = document.createElement('button'); button.textContent = label;
    button.addEventListener('click', action); controls.append(button);
  }
  for (const view of ['l1', 'b1', 'dual', 'ffu'] as const) {
    const button = document.createElement('button'); button.textContent = view.toUpperCase();
    button.addEventListener('click', () => {
      void acceptance.structureView(view).catch(error => gpuErrors.push(String(error)));
    }); controls.append(button);
  }
  document.body.append(controls);
}
void mount().catch(error => {
  gpuErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); output.textContent = String(error);
});
