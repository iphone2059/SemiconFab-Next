// Test-only entry: never imported by the application or its production build.
import {
  addToScene, attachControl, createArcRotateCamera, createBox,
  createHemisphericLight, createPbrMaterial, forceWebGpuDeviceLossForTesting,
  getRenderingContexts, onBeforeRender, onEngineGpuError,
  type EngineContext, type SceneContext,
} from '@babylonjs/lite';
import { createLiteRuntime, type LiteRuntime } from '../../src/render/lite/runtime';

const canvas = document.querySelector('canvas')!;
const output = document.querySelector('output')!;
const states: string[] = [];
const gpuErrors: string[] = [];
let frames = 0;
let runtime: LiteRuntime | undefined;
let context: { engine: EngineContext; scene: SceneContext } | undefined;

async function mount(abortImmediately = false) {
  runtime?.dispose();
  const controller = new AbortController();
  const next = createLiteRuntime(canvas, {
    signal: controller.signal,
    compose(scene, engine) {
      scene.clearColor = { r: 0.86, g: 0.93, b: 0.99, a: 1 };
      const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 0, y: 0, z: 0 });
      scene.camera = camera;
      const detachControl = attachControl(camera, canvas, scene);
      const detachErrors = onEngineGpuError(engine, error => gpuErrors.push(error.message));
      onBeforeRender(scene, () => { frames++; });
      addToScene(scene, createHemisphericLight([0, 1, 0], 1));
      const box = createBox(engine, { size: 2 });
      box.material = createPbrMaterial({ baseColorFactor: [0.2, 0.7, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.55 });
      addToScene(scene, box);
      return () => { detachControl(); detachErrors(); };
    },
    onStatus(status, error) {
      states.push(status); output.textContent = `Lite P1 · ${status}`;
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
  };
}

const acceptance = {
  mount, snapshot,
  dispose() { runtime?.dispose(); return snapshot(); },
  loseDevice() { if (!context) throw new Error('Scene not ready'); forceWebGpuDeviceLossForTesting(context.engine); },
};
Object.assign(window, { __liteAcceptance: acceptance });
void mount().catch(error => { gpuErrors.push(String(error)); output.textContent = String(error); });
