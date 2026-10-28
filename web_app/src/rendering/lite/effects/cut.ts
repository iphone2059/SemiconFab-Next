/**
 * Section-cut visualizer effect owner for the native Lite renderer.
 *
 * Owns only the effects-shader half of the physical cut: the single render-space plane
 * that every X-Ray palette / wafer-trail shader discards against, plus the scene
 * `clipPlane` value native PBR materials read (babylon-webgpu.ts:560-574). The
 * PBR/Standard MaterialPlugin half of the same cut remains a separate owner
 * (web_app/src/rendering/lite/cut-plane.ts); both derive identical render-space literals
 * from this one conversion, so the shader discard and the native plugin clip the same
 * half-space without sharing material state.
 *
 * Source plane (babylon-webgpu.ts:567-573) is authored in Next's RH domain; the native
 * render boundary reflects Z exactly once, so only the Z normal component flips.
 */
import { setClipPlane, type ClipPlane, type SceneContext } from '@babylonjs/lite';

export type LiteCutAxis = 'X' | 'Y' | 'Z';

/** Source clamp shared with the PBR plugin owner (babylon-webgpu.ts:560-574). */
const CUT_PLANE_MIN = -60;
const CUT_PLANE_MAX = 60;

/** Structured shader uniform contract shared by the X-Ray palette and wafer-trail programs. */
export const CUT_PLANE_UNIFORM = { name: 'cutPlane', type: 'vec4<f32>' } as const;

export interface LiteCutEffect {
  /**
   * Converts one source cut request into the render-space plane, publishes it to
   * `scene.clipPlane` (or clears it), and returns the copy every effects shader discards
   * against. Event-driven: there is no per-frame work.
   */
  setPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): ClipPlane;
  /** Current effects-shader plane value; `[0, 0, 0, 0]` while the cut is inactive. */
  readonly plane: ClipPlane;
  dispose(): void;
}

export function createLiteCutEffect(scene: SceneContext): LiteCutEffect {
  let plane: ClipPlane = [0, 0, 0, 0];
  let disposed = false;

  function setPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): ClipPlane {
    if (disposed) return plane;
    if (!active) {
      scene.clipPlane = null;
      plane = [0, 0, 0, 0];
      return plane;
    }
    const flipped = invert ? -1 : 1;
    const clamped = Math.max(CUT_PLANE_MIN, Math.min(CUT_PLANE_MAX, position));
    const next: ClipPlane = axis === 'X'
      ? [flipped, 0, 0, -flipped * clamped]
      : axis === 'Y'
        ? [0, flipped, 0, -flipped * clamped]
        : [0, 0, -flipped, -flipped * clamped];
    setClipPlane(scene, next);
    plane = [next[0], next[1], next[2], next[3]];
    return plane;
  }

  function dispose(): void {
    disposed = true;
  }

  return {
    setPlane,
    get plane() { return plane; },
    dispose,
  };
}
