// Test-only entry: never imported by the application or its production build.
import {
  addToScene, attachControl, createArcRotateCamera, createBox,
  createHemisphericLight, createPbrMaterial, forceWebGpuDeviceLossForTesting,
  getRenderingContexts, onBeforeRender, onEngineGpuError,
  type ArcRotateCamera, type EngineContext, type SceneContext,
} from '@babylonjs/lite';
import { createLiteRuntime, type LiteRuntime } from '../../src/render/lite/runtime';
import { createLiteEquipment, type LiteEquipment } from '../../src/render/lite/geometry/tool-families';

const canvas = document.querySelector('canvas')!;
const output = document.querySelector('output')!;
const states: string[] = [];
const gpuErrors: string[] = [];
let frames = 0;
let runtime: LiteRuntime | undefined;
let context: { engine: EngineContext; scene: SceneContext } | undefined;
const equipmentScene = new URLSearchParams(location.search).get('scene') === 'equipment';
let equipment: LiteEquipment | undefined;
let camera: ArcRotateCamera | undefined;

async function mount(abortImmediately = false) {
  runtime?.dispose();
  context = undefined;
  equipment = undefined;
  const controller = new AbortController();
  const next = createLiteRuntime(canvas, {
    signal: controller.signal,
    compose(scene, engine) {
      // Track this generation at acquisition, including mounts aborted before ready resolves.
      context = { engine, scene };
      scene.clearColor = { r: 0.86, g: 0.93, b: 0.99, a: 1 };
      camera = equipmentScene
        ? createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 115, { x: 0, y: 1, z: 0 })
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
      return () => { detachControl(); detachErrors(); };
    },
    onStatus(status, error) {
      if (status === 'lost') equipment?.prepareForDeviceRecovery();
      states.push(status); output.textContent = `Lite ${equipmentScene ? 'P2 equipment · 121 tools' : 'P1'} · ${status}`;
      if (error) gpuErrors.push(String(error));
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
    status: runtime?.status,
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
    camera.radius = 145;
  },
};
Object.assign(window, { __liteAcceptance: acceptance });
void mount().catch(error => { gpuErrors.push(String(error)); output.textContent = String(error); });
