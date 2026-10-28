import { expect, it } from 'vitest';
import { bindSourceOrbitInput, createSourceOrbitMotion, type OrbitPose } from '../../src/rendering/lite/source-orbit-input';

function motionFixture(position: readonly [number, number, number] = [0, 0, 10]) {
  let pose: OrbitPose = { position, target: [0, 0, 0] };
  const motion = createSourceOrbitMotion(() => pose, (nextPosition, nextTarget) => {
    pose = { position: nextPosition, target: nextTarget };
  });
  return { motion, pose: () => pose };
}

it('applies rotation immediately at half the r128 amplitude and stops while the pointer is held still', () => {
  const { motion, pose } = motionFixture();
  const angle = () => Math.atan2(pose().position[0], pose().position[2]);
  motion.beginDrag();
  motion.rotate(100, 0, 200); // r128 would accumulate -PI radians here
  motion.update(); // consumed in full: half sensitivity -> -PI/2
  expect(angle()).toBeCloseTo(-Math.PI * 0.5, 10);
  const held = angle();
  // The frame loop keeps calling update() while the button is still down; with no
  // new pointer movement the camera must not keep rotating.
  for (let frame = 0; frame < 10; frame += 1) motion.update();
  expect(angle()).toBe(held);
  motion.release();
  motion.clear();
  const before = pose().position;
  motion.update();
  expect(pose().position).toEqual(before);
});

it('matches r128 wheel direction and magnitude-independent 0.95 increments', () => {
  const { motion, pose } = motionFixture();
  motion.wheel(-1); motion.update();
  expect(Math.hypot(...pose().position)).toBeCloseTo(9.5, 10);
  motion.wheel(120); motion.update();
  expect(Math.hypot(...pose().position)).toBeCloseTo(10, 10);
  motion.wheel(-0.001); motion.update();
  expect(Math.hypot(...pose().position)).toBeCloseTo(9.5, 10);
  motion.pinch(100, 125); motion.update();
  expect(Math.hypot(...pose().position)).toBeCloseTo(7.6, 10);
});

it('uses camera-aligned perspective pan and damps it like r128', () => {
  const { motion, pose } = motionFixture();
  motion.pan(20, 0, 100);
  motion.update();
  const expected = -(2 * 20 * 10 * Math.tan(Math.PI / 8) / 100) * 0.06;
  expect(pose().target[0]).toBeCloseTo(expected, 10);
  expect(pose().target[1]).toBeCloseTo(0, 10);
  motion.update();
  expect(pose().target[0]).toBeCloseTo(expected * (1 + 0.94), 10);
});

it('carries a small decaying inertia after a quick release but not after a pause', async () => {
  const { motion, pose } = motionFixture();
  const angle = () => Math.atan2(pose().position[0], pose().position[2]);
  motion.beginDrag();
  motion.rotate(100, 0, 200);
  motion.update();
  const released = angle();
  motion.release();
  let previous = released;
  for (let frame = 0; frame < 6; frame += 1) {
    motion.update();
    const current = angle();
    expect(current, 'frame ' + frame).toBeLessThan(previous);
    previous = current;
  }
  for (let frame = 0; frame < 80; frame += 1) motion.update();
  const tail = angle() - released;
  expect(tail).toBeLessThan(0); // same direction as the drag
  expect(tail).toBeGreaterThan(-0.15); // only a few degrees
  const settled = angle();
  motion.update();
  expect(angle()).toBe(settled); // the tail ends instead of drifting forever

  // A pause before release means no inertia at all.
  motion.clear();
  motion.beginDrag();
  motion.rotate(100, 0, 200);
  motion.update();
  const paused = angle();
  await new Promise((resolve) => setTimeout(resolve, 120));
  motion.release();
  for (let frame = 0; frame < 10; frame += 1) motion.update();
  expect(angle()).toBe(paused);

  // Starting a new drag clears any pending tail as well.
  motion.clear();
  motion.beginDrag();
  motion.rotate(100, 0, 200);
  motion.update();
  motion.release();
  const beforeNewDrag = angle();
  motion.beginDrag();
  for (let frame = 0; frame < 10; frame += 1) motion.update();
  expect(angle()).toBe(beforeNewDrag);
});

it('enforces source zoom and polar limits', () => {
  const { motion, pose } = motionFixture([0, 2, 4]);
  for (let index = 0; index < 100; index += 1) { motion.wheel(-120); motion.update(); }
  expect(Math.hypot(
    pose().position[0] - pose().target[0],
    pose().position[1] - pose().target[1],
    pose().position[2] - pose().target[2],
  )).toBeCloseTo(4, 8);
  motion.rotate(0, -10000, 100);
  motion.update();
  const offsetY = pose().position[1] - pose().target[1];
  expect(offsetY).toBeGreaterThanOrEqual(0);
});

class TestCanvas extends EventTarget {
  clientHeight = 200;
  style = { touchAction: '' };
  ownerDocument = new EventTarget();
  focusCalls = 0;
  focus() { this.focusCalls++; }
}
function event(type: string, values: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true, bubbles: true }), values);
}
const pointer = (type: string, values: Record<string, unknown> = {}) =>
  event(type, { pointerType: 'mouse', pointerId: 7, button: 0, clientX: 0, clientY: 0,
    ctrlKey: false, metaKey: false, shiftKey: false, ...values });

it('routes left drag to rotate, right drag and left+ctrl to pan, middle drag to dolly', () => {
  const canvas = new TestCanvas();
  const { motion, pose } = motionFixture();
  const release = bindSourceOrbitInput(canvas as unknown as HTMLCanvasElement, motion);
  canvas.dispatchEvent(pointer('pointerdown'));
  canvas.ownerDocument.dispatchEvent(pointer('pointermove', { clientX: 100 }));
  expect(pose().position[0]).toBeLessThan(0);
  canvas.ownerDocument.dispatchEvent(pointer('pointerup', { clientX: 100 }));
  motion.clear();
  const beforePan = pose().target[0];
  canvas.dispatchEvent(pointer('pointerdown', { button: 2 }));
  canvas.ownerDocument.dispatchEvent(pointer('pointermove', { clientX: 30 }));
  expect(pose().target[0]).not.toBe(beforePan);
  canvas.ownerDocument.dispatchEvent(pointer('pointerup'));
  motion.clear();
  const ctrlPanBefore = pose().target[0];
  canvas.dispatchEvent(pointer('pointerdown', { button: 0, ctrlKey: true }));
  canvas.ownerDocument.dispatchEvent(pointer('pointermove', { clientX: 25, ctrlKey: true }));
  expect(pose().target[0]).not.toBe(ctrlPanBefore);
  canvas.ownerDocument.dispatchEvent(pointer('pointerup', { ctrlKey: true }));
  motion.clear();
  canvas.dispatchEvent(pointer('pointerdown', { button: 1 }));
  const previousRadius = Math.hypot(...pose().position.map((x, i) => x - pose().target[i]));
  canvas.ownerDocument.dispatchEvent(pointer('pointermove', { clientY: 20, button: 1 }));
  const nextRadius = Math.hypot(...pose().position.map((x, i) => x - pose().target[i]));
  expect(nextRadius).toBeGreaterThan(previousRadius);
  canvas.ownerDocument.dispatchEvent(pointer('pointerup'));
  expect(canvas.focusCalls).toBe(4);
  release();
  expect(canvas.style.touchAction).toBe('');
});

it('stops the camera while the button is held still and eases slightly after release', () => {
  const canvas = new TestCanvas(), { motion, pose } = motionFixture();
  const release = bindSourceOrbitInput(canvas as unknown as HTMLCanvasElement, motion);
  const angle = () => Math.atan2(pose().position[0], pose().position[2]);
  canvas.dispatchEvent(pointer('pointerdown'));
  canvas.ownerDocument.dispatchEvent(pointer('pointermove', { clientX: 100 }));
  const held = angle();
  // Per-frame updates while the button is still down must not drift.
  motion.update(); motion.update();
  expect(angle()).toBe(held);
  canvas.ownerDocument.dispatchEvent(pointer('pointerup', { clientX: 100 }));
  motion.update();
  expect(angle()).toBeLessThan(held); // quick release eases a little further
  release();
});

it('consumes wheel only on the canvas, preserving source sign-only increments and cleanup', () => {
  const canvas = new TestCanvas(), { motion, pose } = motionFixture();
  let starts = 0;
  const release = bindSourceOrbitInput(canvas as unknown as HTMLCanvasElement, motion, () => { starts++; });
  const zoom = event('wheel', { deltaY: -240 });
  canvas.dispatchEvent(zoom);
  expect(zoom.defaultPrevented).toBe(true);
  expect(Math.hypot(...pose().position)).toBeCloseTo(9.5);
  release();
  canvas.dispatchEvent(event('wheel', { deltaY: -120 }));
  expect(Math.hypot(...pose().position)).toBeCloseTo(9.5);
  expect(starts).toBe(1);
});

it('uses r128 single-finger rotate and two-finger pinch plus pan', () => {
  const canvas = new TestCanvas(), { motion, pose } = motionFixture();
  const release = bindSourceOrbitInput(canvas as unknown as HTMLCanvasElement, motion);
  canvas.dispatchEvent(event('touchstart', { touches: [{ pageX: 0, pageY: 0 }] }));
  canvas.dispatchEvent(event('touchmove', { touches: [{ pageX: 100, pageY: 0 }] }));
  expect(pose().position[0]).toBeLessThan(0);
  canvas.dispatchEvent(event('touchend', { touches: [] }));
  motion.clear();
  const before = Math.hypot(...pose().position.map((x, i) => x - pose().target[i]));
  canvas.dispatchEvent(event('touchstart', { touches: [{ pageX: -50, pageY: 0 }, { pageX: 50, pageY: 0 }] }));
  canvas.dispatchEvent(event('touchmove', { touches: [{ pageX: -65, pageY: 0 }, { pageX: 65, pageY: 0 }] }));
  const after = Math.hypot(...pose().position.map((x, i) => x - pose().target[i]));
  expect(after).toBeLessThan(before);
  release();
});
