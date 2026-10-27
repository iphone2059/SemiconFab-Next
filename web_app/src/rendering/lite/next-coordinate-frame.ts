import { createArcRotateCamera, createTransformNode, decomposeMat4, setParent,
  type ArcRotateCamera, type SceneNode } from '@babylonjs/lite';

type Point = readonly [number, number, number];
export type NextReferenceView = 'home' | 'iso' | 'top' | 'l1' | 'b1' | 'dual' | 'exploded';
// Literal poses from babylon-webgpu.ts:setView and twin-page.tsx:flyLevel.
const poses: Record<NextReferenceView, { position: Point; target: Point }> = {
  // Product home pose: babylon-webgpu.ts mount (alpha PI/2, beta acos(58/homeRadius), radius homeRadius).
  home: { position: [0, 58, 68], target: [0, 0, 0] },
  iso: { position: [38, 48, 58], target: [0, 0, 0] },
  top: { position: [0, 95, 0.1], target: [0, 0, 0] },
  l1: { position: [0, 52, 64], target: [0, 2, 0] },
  b1: { position: [-15, -2, 34], target: [-15, -6, -5] },
  dual: { position: [0, 38, 62], target: [0, -3, 0] },
  exploded: { position: [55, 44, 72], target: [0, -4, 0] },
};

/** Domain layout stays in Next's RH metres; only the native render boundary reflects Z. */
export function attachNextCoordinateFrame(nodes: readonly SceneNode[]) {
  const frame = createTransformNode('next-rh-to-lite-lh');
  frame.scaling.z = -1;
  for (const node of new Set(nodes)) {
    const { translation, rotation, scale } = decomposeMat4(node.worldMatrix);
    setParent(node, frame);
    // setParent preserves world space; restore the original domain transform as local TRS.
    node.position.set(translation.x, translation.y, translation.z);
    node.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    node.scaling.set(scale.x, scale.y, scale.z);
  }
  return frame;
}

export function applyNextReferenceView(camera: ArcRotateCamera, view: NextReferenceView) {
  const { position, target } = poses[view];
  const dx = position[0] - target[0], dy = position[1] - target[1], dz = position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz);
  camera.target.x = target[0]; camera.target.y = target[1]; camera.target.z = -target[2];
  camera.alpha = Math.atan2(-dz, dx); camera.beta = Math.acos(dy / radius); camera.radius = radius;
}

export function createNextReferenceCamera(view: NextReferenceView = 'iso') {
  const camera = createArcRotateCamera(0, Math.PI / 4, 1, { x: 0, y: 0, z: 0 });
  camera.fov = Math.PI / 4; camera.nearPlane = 0.5; camera.farPlane = 600;
  // The r128 orbit adapter owns inertia; no native Lite input hook is installed.
  camera.inertia = 0; camera.panningSensibility = 45;
  applyNextReferenceView(camera, view);
  return camera;
}
