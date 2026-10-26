// Test-only entry: never imported by the application or its production build.
import {
  addToScene, attachControl, createArcRotateCamera, createBox,
  createHemisphericLight, createPbrMaterial, forceWebGpuDeviceLossForTesting,
  getRenderingContexts, getTextureMetadata, getTextureTransform, onBeforeRender, onEngineGpuError, setSubtreeVisible,
  type ArcRotateCamera, type EngineContext, type SceneContext,
} from '@babylonjs/lite';
import { createLiteRuntime, type LiteRuntime } from '../../src/render/lite/runtime';
import { createLiteEquipment, type LiteEquipment } from '../../src/render/lite/geometry/tool-families';
import { createLiteStaticStructure, prepareStaticStructureEnvironment, type LiteStaticStructure } from '../../src/render/lite/geometry/static-structure';

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
let loadingStage = 'mount';

async function mount(abortImmediately = false) {
  runtime?.dispose();
  context = undefined;
  equipment = undefined;
  structure = undefined;
  loadingStage = 'acquire';
  const controller = new AbortController();
  const next = createLiteRuntime(canvas, {
    signal: controller.signal,
    async compose(scene, engine) {
      loadingStage = 'compose';
      // Track this generation at acquisition, including mounts aborted before ready resolves.
      context = { engine, scene };
      scene.clearColor = { r: 0.86, g: 0.93, b: 0.99, a: 1 };
      camera = equipmentScene
        ? createArcRotateCamera(-Math.PI / 3, Math.PI / 3, structureScene ? 155 : 115, { x: 0, y: 1, z: 0 })
        : createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 0, y: 0, z: 0 });
      scene.camera = camera;
      const detachControl = attachControl(camera, canvas, scene);
      const detachErrors = onEngineGpuError(engine, error => gpuErrors.push(error.message));
      onBeforeRender(scene, () => { frames++; });
      addToScene(scene, createHemisphericLight([0, 1, 0], 1));
      if (equipmentScene) equipment = createLiteEquipment(scene, engine);
      else {
        const box = createBox(engine, { size: 2 });
        box.material = createPbrMaterial({ baseColorFactor: [0.2, 0.7, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.55 });
        addToScene(scene, box);
      }
      const mountedStructure = structureScene ? createLiteStaticStructure(scene, engine) : undefined;
      structure = mountedStructure;
      mountedStructure?.setVisible('ffu', false);
      mountedStructure?.setVisible('b1', false);
      if (mountedStructure) {
        loadingStage = 'environment';
        try { await prepareStaticStructureEnvironment(scene); }
        catch (error) { mountedStructure.dispose(); detachControl(); detachErrors(); throw error; }
      }
      loadingStage = 'register';
      return () => { mountedStructure?.dispose(); detachControl(); detachErrors(); };
    },
    onStatus(status, error) {
      if (status === 'lost') { equipment?.prepareForDeviceRecovery(); structure?.prepareForDeviceRecovery(); }
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
    width: canvas.width, height: canvas.height,
    equipment: equipment ? {
      tools: equipment.tools.length, batches: equipment.batches.length,
      instances: equipment.batches.reduce((sum, batch) => sum + (batch.mesh.thinInstances?.count ?? 0), 0),
      identities: equipment.tools.map(tool => ({ instanceId: tool.instanceId, recordId: tool.recordId,
        mapped: tool.parts.every(part => equipment!.resolve(equipment!.batches[part.batchIndex].mesh, part.instanceIndex) === tool) })),
    } : undefined,
    structure: structure ? {
      parts: structure.parts.length, batches: structure.batches.length, lights: structure.lights.length,
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
  topView() {
    if (!camera) throw new Error('Scene not ready');
    camera.beta = 0.01;
    camera.alpha = -Math.PI / 2;
    camera.radius = structureScene ? 180 : 145;
  },
  structureView(view: 'l1' | 'b1' | 'dual' | 'ffu') {
    if (!structure || !equipment || !camera) throw new Error('Static scene not ready');
    structure.setVisible('shell', view !== 'b1');
    structure.setVisible('ffu', view === 'ffu');
    structure.setVisible('b1', view === 'b1' || view === 'dual');
    structure.setOffset('b1', view === 'dual' ? -18 : 0);
    for (const batch of equipment.batches) setSubtreeVisible(batch.mesh, view !== 'b1');
    camera.target.y = view === 'b1' ? -4 : 0;
    camera.radius = 155; camera.beta = Math.PI / 3; camera.alpha = -Math.PI / 3;
  },
};
Object.assign(window, { __liteAcceptance: acceptance });
if (structureScene) {
  const controls = document.createElement('nav');
  controls.setAttribute('aria-label', 'Static scene layers');
  for (const view of ['l1', 'b1', 'dual', 'ffu'] as const) {
    const button = document.createElement('button'); button.textContent = view.toUpperCase();
    button.addEventListener('click', () => acceptance.structureView(view)); controls.append(button);
  }
  document.body.append(controls);
}
void mount().catch(error => {
  gpuErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); output.textContent = String(error);
});
