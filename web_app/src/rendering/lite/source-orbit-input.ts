/**
 * Camera input/kinematics adapter for the twin scene.
 *
 * Event deltas, perspective pan, discrete dolly and the spherical accumulator
 * follow the OrbitControls shipped by the source SemiconFab twin (Three.js r128,
 * MIT License). Two deliberate deviations from r128 — requested after user
 * feedback — make left-button orbiting feel direct:
 *
 * 1. Rotation follows the pointer immediately: the pending spherical delta is
 *    consumed in full by the next update instead of being spread over frames
 *    with dampingFactor 0.06. While the button is held and the pointer stops,
 *    the camera stops with it instead of drifting on.
 * 2. Drag sensitivity is halved (ROTATE_SENSITIVITY) so small mouse movements do
 *    not swing the camera too far, and releasing the button right after a quick
 *    drag carries a small decaying inertia (a few degrees) instead of r128's
 *    damped remainder.
 *
 * Pan keeps the source 0.06 damping / 0.94 retention and wheel/pinch keep the
 * source sign-only discrete dolly, so translation and zoom stay on the frozen
 * source kinematics. Source: three.js r128/examples/js/controls/OrbitControls.js.
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
  /** Pointer went down for a drag: drop any release inertia still decaying. */
  beginDrag(): void;
  /** Left-button rotate drag ended: turn the last applied step into a short inertia. */
  release(): void;
}
const DAMPING = 0.06;                    // source pan damping per update
const RETENTION = 1 - DAMPING;
const ROTATE_SENSITIVITY = 0.5;          // half of the r128 rotation amplitude
const RELEASE_INERTIA = 1.2;             // fraction of the last applied step kept on release
const INERTIA_DAMPING = 0.3;             // applied per frame while the release tail decays
const INERTIA_RETENTION = 0.8;           // remainder kept per frame
const MAX_INERTIA_STEP = 0.04;           // rad per axis: a flick only adds a few degrees
const RELEASE_WINDOW_MS = 90;            // only a quick release (a flick) produces inertia
const INERTIA_EPSILON = 1e-4;
const WHEEL_SCALE = 0.95;
const FOV_RADIANS = Math.PI / 4;
const EPSILON = 1e-6;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.03;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const clampInertiaStep = (value: number): number => clamp(value, -MAX_INERTIA_STEP, MAX_INERTIA_STEP);
const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

export function createSourceOrbitMotion(
  read: () => OrbitPose,
  /** `radius` carries the exact clamped distance so the adapter does not re-derive it from rounded position components. */
  apply: (position: OrbitPoint, target: OrbitPoint, radius?: number) => void,
): SourceOrbitMotion {
  let thetaDelta = 0, phiDelta = 0;
  let inertiaTheta = 0, inertiaPhi = 0;
  let lastRotateTheta = 0, lastRotatePhi = 0, lastRotateAt = Number.NEGATIVE_INFINITY;
  let panX = 0, panY = 0, panZ = 0;
  let scale = 1;
  const validHeight = (height: number) => Number.isFinite(height) && height > 0;

  const motion: SourceOrbitMotion = {
    rotate(dx, dy, height) {
      if (!validHeight(height) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      // OrbitControls uses clientHeight for both axes, not clientWidth.
      thetaDelta -= 2 * Math.PI * dx / height * ROTATE_SENSITIVITY;
      phiDelta -= 2 * Math.PI * dy / height * ROTATE_SENSITIVITY;
      // Remember the last applied step so a quick release can carry a little of it into inertia.
      lastRotateTheta = thetaDelta; lastRotatePhi = phiDelta; lastRotateAt = nowMs();
    },
    beginDrag() {
      inertiaTheta = inertiaPhi = 0;
      lastRotateTheta = lastRotatePhi = 0;
      lastRotateAt = Number.NEGATIVE_INFINITY;
    },
    release() {
      // A quick release (flick) keeps a small decaying tail; pausing first means no inertia.
      if (lastRotateAt !== Number.NEGATIVE_INFINITY && nowMs() - lastRotateAt <= RELEASE_WINDOW_MS) {
        inertiaTheta += clampInertiaStep(lastRotateTheta * RELEASE_INERTIA);
        inertiaPhi += clampInertiaStep(lastRotatePhi * RELEASE_INERTIA);
      }
      lastRotateTheta = lastRotatePhi = 0;
      lastRotateAt = Number.NEGATIVE_INFINITY;
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
      thetaDelta = phiDelta = 0;
      inertiaTheta = inertiaPhi = 0;
      lastRotateTheta = lastRotatePhi = 0;
      lastRotateAt = Number.NEGATIVE_INFINITY;
      panX = panY = panZ = 0;
      scale = 1;
    },
    update() {
      const hasDrag = thetaDelta !== 0 || phiDelta !== 0;
      const hasInertia = inertiaTheta !== 0 || inertiaPhi !== 0;
      if (!hasDrag && !hasInertia && panX === 0 && panY === 0 && panZ === 0 && scale === 1) return;
      const { position, target } = read();
      const ox = position[0] - target[0], oy = position[1] - target[1], oz = position[2] - target[2];
      const oldRadius = Math.hypot(ox, oy, oz);
      if (!Number.isFinite(oldRadius) || oldRadius <= 0) { motion.clear(); return; }
      // Rotation: a drag step is consumed in full (immediate response, no drift while
      // the pointer is still); a release tail decays by INERTIA_DAMPING per frame.
      const thetaStep = thetaDelta + inertiaTheta * INERTIA_DAMPING;
      const phiStep = phiDelta + inertiaPhi * INERTIA_DAMPING;
      thetaDelta = 0; phiDelta = 0;
      if (hasInertia) {
        inertiaTheta *= INERTIA_RETENTION; inertiaPhi *= INERTIA_RETENTION;
        if (Math.abs(inertiaTheta) < INERTIA_EPSILON) inertiaTheta = 0;
        if (Math.abs(inertiaPhi) < INERTIA_EPSILON) inertiaPhi = 0;
      }
      // THREE.Spherical.setFromVector3: theta = atan2(x,z), phi = acos(y/r).
      const theta = Math.atan2(ox, oz) + thetaStep;
      const phi = Math.max(EPSILON, Math.min(MAX_POLAR_ANGLE,
        Math.acos(Math.max(-1, Math.min(1, oy / oldRadius))) + phiStep));
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
      panX *= RETENTION; panY *= RETENTION; panZ *= RETENTION;
      scale = 1; // r128 zoom has no damping.
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
    const mode = mouseMode;
    mouseMode = 'none'; pointerId = null;
    // Only a real button release after a rotate drag eases the camera; cancel/dispose do not.
    if (mode === 'rotate' && event.type === 'pointerup') motion.release();
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
    motion.beginDrag();
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
    motion.beginDrag();
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
  const touchEnd = () => {
    if (touchMode === 'rotate') motion.release();
    touchMode = 'none';
  };
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
