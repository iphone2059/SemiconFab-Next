// Isolated GPU regression; never reachable from the production entry.
import {
  addToScene, createArcRotateCamera, createBox, createCsmDirectionalShadowGenerator,
  createDirectionalLight, createEngine, createPbrMaterial, createPlane, createSceneContext,
  disposeEngine, disposeScene, onEngineGpuError, registerScene, setPbrTransmission,
  setShaderUniform, startEngine, stopEngine, waitForGpuIdle, type ShaderMaterial,
} from '@babylonjs/lite';
import { createLiteEffects } from '../../src/rendering/lite/effects';
import { prepareStaticStructureEnvironment } from '../../src/rendering/lite/geometry/static-structure';

const output = document.querySelector('output')!;
const errors: string[] = [];
try {
  const canvas = document.querySelector('canvas')!;
  const engine = await createEngine(canvas);
  const detachErrors = onEngineGpuError(engine, error => errors.push(error.message));
  const scene = createSceneContext(engine);
  const params = new URLSearchParams(location.search);
  const background = params.has('white') ? 1 : 0;
  scene.clearColor = { r: background, g: background, b: background, a: 1 };
  Object.assign(scene.imageProcessing, { exposure: 1, contrast: 1, toneMappingEnabled: false });
  scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 3, { x: 0, y: 0, z: 0 });
  const light = createDirectionalLight([0, -1, 0]);
  const generator = createCsmDirectionalShadowGenerator(engine, light, { numCascades: 2, mapSize: 256 });
  scene.shadowGenerators.push(generator); // Scene owns cleanup; no shadow tasks needed by this test.
  const effects = createLiteEffects(scene, engine, { shadows: generator });
  const ghost = params.has('ghost');
  const box = ghost ? createPlane(engine, { size: 2 }) : createBox(engine, { size: 2 });
  box.material = createPbrMaterial(); addToScene(scene, box);
  effects.configureXrayTargets([{ mesh: box, role: 'subfab' }]); effects.setXrayFilter('all');
  const material = box.material as ShaderMaterial;
  setShaderUniform(material, 'xrayTint', ghost ? [.625, .625, .625, 0] : [.25, .5, .75, 0]);
  setShaderUniform(material, 'xrayGlow', [0, 0, 0, 0]);
  setShaderUniform(material, 'xrayTime', 0);
  if (ghost) setShaderUniform(material, 'xrayParams', [1, .15, 0, 1000]);
  if (params.has('transmission')) {
    const glass = createBox(engine); glass.position.x = 1000;
    const glassMaterial = createPbrMaterial(); setPbrTransmission(glassMaterial, { intensity: .5 });
    glass.material = glassMaterial; addToScene(scene, glass);
    await prepareStaticStructureEnvironment(scene);
  }
  await registerScene(scene); await startEngine(engine); await waitForGpuIdle(engine);
  output.textContent = 'ready';
  Object.assign(window, { __COLOR_TEST__: { errors } });
  addEventListener('pagehide', () => {
    stopEngine(engine); detachErrors(); effects.dispose(); disposeScene(scene); disposeEngine(engine);
  }, { once: true });
} catch (error) { output.textContent = String(error); throw error; }
