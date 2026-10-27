/**
 * Input/kinematics parity with the OrbitControls shipped by the source
 * SemiconFab twin (Three.js r128, MIT License).
 *
 * This is a small native Lite camera controller, not a Three.js dependency.
 * It reproduces r128's event deltas, perspective pan, discrete dolly and
 * damped spherical/pan accumulator. In particular, dampingFactor = 0.06 is
 * applied to the pending delta on each update and the remainder retains 0.94.
 * Like the source, update() happens at input time AND on every render frame.
 * Source: three.js r128/examples/js/controls/OrbitControls.js.
 */
export type OrbitPoint = readonly [number, number, number];
export interface OrbitPose {
  readonly position: OrbitPoint;
  readonly target: OrbitPoint;
}
export interface SourceOrbitMotion {
  rotate(dx: number, dy: number, clientHeight: number): void;
  pan(dx: number, dy: number, clientHeight: number): void;
  wheel(deltaY: number): void;
  dragDolly(deltaY: number): void;
  pinch(previousDistance: number, nextDistance: number): void;
  update(): void;
  clear(): void;
}
const DAMPING = 0.06;
const RETENTION = 1 - DAMPING;
const WHEEL_SCALE = 0.95;
const FOV_RADIANS = Math.PI / 4;
const EPSILON = 1e-6;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.03;

export function createSourceOrbitMotion(
  read: () => OrbitPose,
  /** `radius` carries the exact clamped distance so the adapter does not re-derive it from rounded position components. */
  apply: (position: OrbitPoint, target: OrbitPoint, radius?: number) => void,
): SourceOrbitMotion {
  let thetaDelta = 0, phiDelta = 0;
  let panX = 0, panY = 0, panZ = 0;
  let scale = 1;
  const validHeight = (height: number) => Number.isFinite(height) && height > 0;

  const motion: SourceOrbitMotion = {
    rotate(dx, dy, height) {
      if (!validHeight(height) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      // OrbitControls uses clientHeight for both axes, not clientWidth.
      thetaDelta -= 2 * Math.PI * dx / height;
      phiDelta -= 2 * Math.PI * dy / height;
    },
    pan(dx, dy, height) {
      if (!validHeight(height) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const { position, target } = read();
      const ox = position[0] - target[0], oy = position[1] - target[1], oz = position[2] - target[2];
      const radius = Math.hypot(ox, oy, oz);
      const horizontal = Math.hypot(ox, oz);
      if (radius <= EPSILON || horizontal <= EPSILON) return;
      // Three PerspectiveCamera: 2 * radius * tan(fov/2) / clientHeight.
      // The columns of the Y-up camera's world matrix are right and up.
      const factor = 2 * radius * Math.tan(FOV_RADIANS / 2) / height;
      const leftDistance = dx * factor;
      const upDistance = dy * factor;
      const rightX = oz / horizontal, rightZ = -ox / horizontal;
      const upX = -(ox * oy) / (horizontal * radius);
      const upY = horizontal / radius;
      const upZ = -(oz * oy) / (horizontal * radius);
      panX += -leftDistance * rightX + upDistance * upX;
      panY += upDistance * upY;
      panZ += -leftDistance * rightZ + upDistance * upZ;
    },
    wheel(deltaY) {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      // r128 deliberately uses only the sign of each wheel event.
      scale *= deltaY < 0 ? WHEEL_SCALE : 1 / WHEEL_SCALE;
    },
    dragDolly(deltaY) { motion.wheel(deltaY); },
    pinch(previous, next) {
      if (!Number.isFinite(previous) || !Number.isFinite(next) || previous <= 0 || next <= 0) return;
      // Two-finger spread -> camera distance decreases, like r128 dollyOut(next/previous).
      scale *= previous / next;
    },
    clear() {
      thetaDelta = phiDelta = panX = panY = panZ = 0;
      scale = 1;
    },
    update() {
      if (thetaDelta === 0 && phiDelta === 0 && panX === 0 && panY === 0 && panZ === 0 && scale === 1) return;
      const { position, target } = read();
      const ox = position[0] - target[0], oy = position[1] - target[1], oz = position[2] - target[2];
      const oldRadius = Math.hypot(ox, oy, oz);
      if (!Number.isFinite(oldRadius) || oldRadius <= 0) { motion.clear(); return; }
      // THREE.Spherical.setFromVector3: theta = atan2(x,z), phi = acos(y/r).
      const theta = Math.atan2(ox, oz) + thetaDelta * DAMPING;
      const phi = Math.max(EPSILON, Math.min(MAX_POLAR_ANGLE,
        Math.acos(Math.max(-1, Math.min(1, oy / oldRadius))) + phiDelta * DAMPING));
      const radius = Math.max(4, Math.min(180, oldRadius * scale));
      const nextTarget: OrbitPoint = [
        target[0] + panX * DAMPING,
        target[1] + panY * DAMPING,
        target[2] + panZ * DAMPING,
      ];
      const sinPhi = Math.sin(phi);
      apply([
        nextTarget[0] + radius * sinPhi * Math.sin(theta),
        nextTarget[1] + radius * Math.cos(phi),
        nextTarget[2] + radius * sinPhi * Math.cos(theta),
      ], nextTarget, radius);
      thetaDelta *= RETENTION; phiDelta *= RETENTION;
      panX *= RETENTION; panY *= RETENTION; panZ *= RETENTION;
      scale = 1; // r128 zoom has no damping.
      if (Math.abs(thetaDelta) < 1e-13) thetaDelta = 0;
      if (Math.abs(phiDelta) < 1e-13) phiDelta = 0;
      if (Math.abs(panX) < 1e-13) panX = 0;
      if (Math.abs(panY) < 1e-13) panY = 0;
      if (Math.abs(panZ) < 1e-13) panZ = 0;
    },
  };
  return motion;
}

/** Exclusive canvas input owner: replaces Lite attachControl and page-level zoom. */
export function bindSourceOrbitInput(
  canvas: HTMLCanvasElement, motion: SourceOrbitMotion, onStart?: () => void,
): () => void {
  type MouseMode = 'none' | 'rotate' | 'pan' | 'dolly';
  let mouseMode: MouseMode = 'none', pointerId: number | null = null;
  let mouseX = 0, mouseY = 0;
  let touchMode: 'none' | 'rotate' | 'dolly-pan' = 'none';
  let touchX = 0, touchY = 0, touchDistance = 0;
  const doc = canvas.ownerDocument;
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const movePointer = (event: PointerEvent) => {
    if (mouseMode === 'none' || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
    if (pointerId !== null && event.pointerId !== pointerId) return;
    event.preventDefault();
    const dx = event.clientX - mouseX, dy = event.clientY - mouseY;
    mouseX = event.clientX; mouseY = event.clientY;
    if (mouseMode === 'rotate') motion.rotate(dx, dy, canvas.clientHeight);
    else if (mouseMode === 'pan') motion.pan(dx, dy, canvas.clientHeight);
    else motion.dragDolly(dy);
    motion.update();
  };
  const finishPointer = (event: PointerEvent) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    mouseMode = 'none'; pointerId = null;
    doc.removeEventListener('pointermove', movePointer);
    doc.removeEventListener('pointerup', finishPointer);
    doc.removeEventListener('pointercancel', finishPointer);
  };
  const startPointer = (event: PointerEvent) => {
    if (mouseMode !== 'none' || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
    const modified = event.ctrlKey || event.metaKey || event.shiftKey;
    mouseMode = event.button === 0 ? (modified ? 'pan' : 'rotate')
      : event.button === 1 ? 'dolly'
      : event.button === 2 ? (modified ? 'rotate' : 'pan') : 'none';
    if (mouseMode === 'none') return;
    event.preventDefault();
    canvas.focus();
    onStart?.();
    mouseX = event.clientX; mouseY = event.clientY; pointerId = event.pointerId;
    doc.addEventListener('pointermove', movePointer);
    doc.addEventListener('pointerup', finishPointer);
    doc.addEventListener('pointercancel', finishPointer);
  };
  const wheel = (event: WheelEvent) => {
    if (mouseMode !== 'none' && mouseMode !== 'rotate') return;
    event.preventDefault();
    onStart?.();
    motion.wheel(event.deltaY);
    motion.update();
  };
  const contextmenu = (event: MouseEvent) => { event.preventDefault(); };
  const midpoint = (touches: TouchList): [number, number] => [
    (touches[0].pageX + touches[1].pageX) * 0.5,
    (touches[0].pageY + touches[1].pageY) * 0.5,
  ];
  const distance = (touches: TouchList): number =>
    Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1 && event.touches.length !== 2) { touchMode = 'none'; return; }
    event.preventDefault();
    onStart?.();
    touchMode = event.touches.length === 1 ? 'rotate' : 'dolly-pan';
    if (touchMode === 'rotate') {
      touchX = event.touches[0].pageX; touchY = event.touches[0].pageY;
    } else {
      [touchX, touchY] = midpoint(event.touches);
      touchDistance = distance(event.touches);
    }
  };
  const touchMove = (event: TouchEvent) => {
    if (touchMode === 'none') return;
    event.preventDefault();
    if (touchMode === 'rotate' && event.touches.length === 1) {
      const x = event.touches[0].pageX, y = event.touches[0].pageY;
      motion.rotate(x - touchX, y - touchY, canvas.clientHeight);
      touchX = x; touchY = y;
    } else if (touchMode === 'dolly-pan' && event.touches.length === 2) {
      const nextDistance = distance(event.touches);
      motion.pinch(touchDistance, nextDistance);
      touchDistance = nextDistance;
      const [x, y] = midpoint(event.touches);
      motion.pan(x - touchX, y - touchY, canvas.clientHeight);
      touchX = x; touchY = y;
    } else return;
    motion.update();
  };
  const touchEnd = () => { touchMode = 'none'; };
  canvas.addEventListener('pointerdown', startPointer);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', contextmenu);
  canvas.addEventListener('touchstart', touchStart, { passive: false });
  canvas.addEventListener('touchmove', touchMove, { passive: false });
  canvas.addEventListener('touchend', touchEnd);
  canvas.addEventListener('touchcancel', touchEnd);
  return () => {
    finishPointer({ pointerId: pointerId ?? -1 } as PointerEvent);
    canvas.removeEventListener('pointerdown', startPointer);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', contextmenu);
    canvas.removeEventListener('touchstart', touchStart);
    canvas.removeEventListener('touchmove', touchMove);
    canvas.removeEventListener('touchend', touchEnd);
    canvas.removeEventListener('touchcancel', touchEnd);
    canvas.style.touchAction = previousTouchAction;
  };
}
