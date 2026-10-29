import { expect, it } from 'vitest';
import { createNullEngine, createSceneContext, createArcRotateCamera, runHeadlessSteps } from '@babylonjs/lite';
import { createLiteCamera } from '@/rendering/lite-camera';

function fixture() {
  const engine = createNullEngine(), scene = createSceneContext(engine, { defaultRenderTask: false });
  const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 }); scene.camera = camera;
  return { engine, scene, camera, controls: createLiteCamera(scene, camera) };
}
it('round trips source RH camera poses through the native LH camera', () => {
  const { controls } = fixture();
  controls.setPose([38, 48, 58], [0, 0, 0], 0);
  const pose = controls.readPose();
  [38, 48, 58].forEach((value, axis) => expect(pose.position[axis]).toBeCloseTo(value, 4));
  expect(pose.target).toEqual([0, 0, 0]); controls.dispose();
});
it('uses the frozen lithography preset and clamps zoom to native source limits', () => {
  const { controls, camera } = fixture();
  controls.preset('litho', 0);
  const pose = controls.readPose();
  [-21, 3.6, -12.5].forEach((value, axis) => expect(pose.position[axis]).toBeCloseTo(value, 4));
  expect(pose.target).toEqual([-30, 1.8, -22]);
  camera.radius = 179; controls.zoom(240); expect(camera.radius).toBe(180);
  camera.radius = 4; controls.zoom(-240); expect(camera.radius).toBe(4); controls.dispose();
});
it('lets a newer camera instruction cancel an older native frame interpolation', async () => {
  const { engine, scene, controls } = fixture();
  controls.setPose([38, 48, 58], [0, 0, 0], 1000);
  runHeadlessSteps(engine, scene, 10, 16);
  controls.setPose([0, 95, 0.1], [0, 0, 0], 0);
  runHeadlessSteps(engine, scene, 80, 16); await Promise.resolve();
  const pose = controls.readPose();
  [0, 95, 0.1].forEach((value, axis) => expect(pose.position[axis]).toBeCloseTo(value, 3));
  controls.dispose();
});
it('disposal cancels frame callbacks and rejects further camera changes', () => {
  const { engine, scene, controls } = fixture();
  controls.setPose([38, 48, 58], [0, 0, 0], 1000);
  runHeadlessSteps(engine, scene, 5, 16); controls.dispose();
  const before = controls.readPose();
  controls.setPose([0, 95, 0], [0, 0, 0], 0); runHeadlessSteps(engine, scene, 80, 16);
  expect(controls.readPose()).toEqual(before);
});
