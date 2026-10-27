import { getCameraPosition, runFrameInterpolation, type ArcRotateCamera, type SceneContext } from '@babylonjs/lite';
import type { SceneViewPreset } from '../../fab-scene';

type Point = readonly [number, number, number];
export interface LiteCameraPose { position: Point; target: Point }
/** Domain poses remain RH. Native Lite owns frame interpolation registration/cancellation. */
export function createLiteCamera(scene: SceneContext, camera: ArcRotateCamera) {
  let transition: AbortController | undefined, disposed = false;
  const readPose = (): LiteCameraPose => {
    const p = getCameraPosition(camera);
    return { position: [p.x, p.y, -p.z || 0], target: [camera.target.x, camera.target.y, -camera.target.z || 0] };
  };
  function cancel() {
    transition?.abort(); transition = undefined;
    camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = camera.inertialPanningY = 0;
  }
  function apply(position: Point, target: Point) {
    const dx = position[0] - target[0], dy = position[1] - target[1], dz = position[2] - target[2];
    const radius = Math.max(0.0001, Math.hypot(dx, dy, dz));
    camera.target.x = target[0]; camera.target.y = target[1]; camera.target.z = -target[2];
    camera.alpha = Math.atan2(-dz, dx); camera.beta = Math.acos(Math.max(-1, Math.min(1, dy / radius))); camera.radius = radius;
  }
  function setPose(position: Point, target: Point, durationMs = 0) {
    if (disposed) return;
    cancel();
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (durationMs <= 0 || reduced) { apply(position, target); return; }
    const from = readPose(), controller = new AbortController(); transition = controller;
    const toPosition = [...position] as [number, number, number], toTarget = [...target] as [number, number, number];
    let elapsed = 0;
    void runFrameInterpolation(scene, deltaSeconds => {
      elapsed += deltaSeconds * 1000;
      const progress = Math.min(1, elapsed / durationMs), eased = 0.5 - Math.cos(progress * Math.PI) / 2;
      const point = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * eased,
        a[1] + (b[1] - a[1]) * eased, a[2] + (b[2] - a[2]) * eased];
      apply(point(from.position, toPosition), point(from.target, toTarget));
      return progress < 1;
    }, controller.signal).catch(error => { if (!controller.signal.aborted) console.error(error); })
      .finally(() => { if (transition === controller) transition = undefined; });
  }
  /** Legacy selectToolByIndex/focusPatrol: keep alpha while snapping/animating to a tool or actor. */
  function focus(target: Point, beta: number, radius: number, durationMs = 0) {
    if (disposed) return;
    if (durationMs <= 0) {
      cancel();
      camera.target.x = target[0]; camera.target.y = target[1]; camera.target.z = -target[2];
      camera.beta = beta; camera.radius = radius;
      return;
    }
    const alpha = camera.alpha, renderZ = -target[2];
    const position: Point = [
      target[0] + Math.cos(alpha) * Math.sin(beta) * radius,
      target[1] + Math.cos(beta) * radius,
      -(renderZ + Math.sin(alpha) * Math.sin(beta) * radius),
    ];
    setPose(position, target, durationMs);
  }
  function preset(view: SceneViewPreset, durationMs = 1000, focus?: Point) {
    const orbit = (alpha: number, beta: number, radius: number, target: Point): Point => [
      target[0] + Math.cos(alpha) * Math.sin(beta) * radius,
      target[1] + Math.cos(beta) * radius, target[2] + Math.sin(alpha) * Math.sin(beta) * radius,
    ];
    if (view === 'top') setPose([0, 95, 0.1], [0, 0, 0], durationMs);
    else if (view === 'litho') setPose([-21, 3.6, -12.5], [-30, 1.8, -22], durationMs);
    else if (view === 'airshower') setPose([-12.5, 4.2, 7.5], [-16.5, 1.5, 3], durationMs);
    else if (view === 'etch') setPose(orbit(1.62, 1.12, 40, [5, 1.4, -14]), [5, 1.4, -14], durationMs);
    else if (view === 'oht') setPose(orbit(1.8, 1.24, 72, [0, 3.8, 0]), [0, 3.8, 0], durationMs);
    else if (view === 'reset') setPose([0, 58, 68], [0, 0, 0], durationMs);
    else if (view === 'focus' && focus) setPose(orbit(Math.PI / 2.2, Math.PI / 3.8, 46, focus), focus, durationMs);
    else if (view === 'iso' && focus) setPose(orbit(Math.PI / 2, Math.PI / 3.64, 52, focus), focus, durationMs);
    else setPose([38, 48, 58], [0, 0, 0], durationMs);
  }
  return { readPose, setPose, preset, focus, cancel,
    zoom(deltaY: number) {
      if (disposed || !Number.isFinite(deltaY)) return;
      cancel(); camera.radius = Math.min(180, Math.max(4, camera.radius * Math.exp(Math.max(-240, Math.min(240, deltaY)) * 0.0028)));
    },
    dispose() { disposed = true; cancel(); },
  };
}
