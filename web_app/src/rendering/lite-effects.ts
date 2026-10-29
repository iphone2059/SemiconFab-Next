/**
 * Native Lite effects assembly: capability composition only.
 *
 * Owns no GPU resource itself. It creates the Domain-RH composition root, assembles the
 * three independent effect owners that have their own resource lifetime, and keeps the
 * public `LiteEffects` facade the composition root (rendering/lite/world.ts) and the
 * acceptance tests depend on:
 *  - `xray`  — X-Ray hologram palette, caster override, borrowed CSM receiver, targets.
 *  - `wafer` — wafer-follow marker/flange/door, amber point light, bounded additive trail.
 *  - `cut`   — the effects-shader cut plane + scene clip plane (visual cutter state only;
 *              rendering/lite/cut-plane.ts remains the PBR/Standard MaterialPlugin owner).
 *
 * Frozen surface parity sources: web_app/src/xray-hologram.ts (hologram program),
 * web_app/src/babylon-webgpu.ts:187-218,512-574 (wafer follow + section cut) and
 * web_app/src/legacy-site.ts:449-524 (per-role X-Ray target application).
 */
import {
  createTransformNode, onSceneDispose,
  type EngineContext, type Mesh, type PointLight, type SceneContext, type ShadowGenerator,
  type TransformNode,
} from '@babylonjs/lite';
import type { LiteXrayFilter } from '@/rendering/lite-effects-xray-state';
import { createLiteCutEffect, type LiteCutAxis } from '@/rendering/lite-effects-cut';
import { createLiteWaferEffect } from '@/rendering/lite-effects-wafer';
import { createXrayEffect, type LiteXrayTarget } from '@/rendering/lite-effects-xray';

export type { LiteCutAxis } from '@/rendering/lite-effects-cut';
export type { LiteXrayTarget, LiteXrayTargetCounts } from '@/rendering/lite-effects-xray';

export interface LiteEffects {
  /** Domain-RH composition root; the composition owner reflects it once at the render boundary. */
  readonly root: TransformNode;
  readonly meshes: readonly Mesh[];
  readonly lights: readonly PointLight[];
  update(deltaMs: number, nowMs: number): void;
  configureXrayTargets(targets: readonly LiteXrayTarget[]): void;
  /** Frozen babylon-webgpu.ts name (legacy-site.ts:635). */
  setXrayFilter(filter: LiteXrayFilter | null): void;
  /** Frozen babylon-webgpu.ts spelling kept for the integration boundary. */
  setXRayFilter(filter: LiteXrayFilter | null): void;
  setCutPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void;
  /**
   * Frozen babylon-webgpu.ts:512 signature is (x, y, z, visible, focus, rotationY?).
   * The Lite effects boundary only owns the marker/light; camera focus stays in the
   * integration camera. Callers that do not request focus pass the rotation directly as
   * the fifth argument (tests/lite-effects.test.ts:131).
   */
  setWaferPoint(x: number, y: number, z: number, visible: boolean,
    focusOrRotationY?: boolean | number, rotationY?: number): void;
  setWaferTrail(points: readonly (readonly [number, number, number])[]): void;
  bindShadows(generator: ShadowGenerator): void;
  /** True once the CSM depth texture is actually bound (after the transition warm-up). */
  readonly shadowLinked: boolean;
  /** Acceptance diagnostics: configured X-Ray target counts per source role. */
  readonly targetCounts: { readonly equipment: number; readonly floor: number; readonly subfab: number; readonly oht: number };
  dispose(): void;
}

export interface LiteEffectsOptions {
  /** Product composition: borrow the live CSM receiver (2-layer depth32float + comparison sampler)
   * so the hologram is modulated by the same shadow map as native PBR. Palette materials cast
   * through a depth-only Standard material, which keeps the CSM caster pass free of the receiver
   * sampler (Lite 1.36 otherwise reports a writable+sampled usage conflict inside refit frames).
   * Standalone unit fixtures omit it and never render the palette. */
  readonly shadows?: ShadowGenerator;
}

export function createLiteEffects(scene: SceneContext, engine: EngineContext, options: LiteEffectsOptions = {}): LiteEffects {
  const root = createTransformNode('native-effects');
  // The X-Ray owner creates only materials (no scene entity), so a malformed shader contract
  // fails before the wafer-follow hierarchy is added to the scene: assembly failure leaks nothing.
  const xray = createXrayEffect({ shadows: options.shadows });
  const wafer = createLiteWaferEffect(scene, engine, { root });
  const cut = createLiteCutEffect(scene);
  let disposed = false;
  let detachSceneDispose: () => void = () => {};

  function setCutPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void {
    if (disposed) return;
    // One conversion is the authority for both effect shader families; the PBR plugin owner
    // (../cut-plane.ts) derives the same render-space literals independently in the world.
    const plane = cut.setPlane(active, axis, position, invert);
    wafer.setCutPlane(plane);
    xray.setCutPlane(plane);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    xray.dispose();
    wafer.dispose();
    cut.dispose();
    detachSceneDispose();
    detachSceneDispose = () => {};
  }

  detachSceneDispose = onSceneDispose(scene, dispose);

  return {
    root, meshes: wafer.meshes, lights: wafer.lights,
    update(_deltaMs: number, nowMs: number) {
      if (disposed) return;
      xray.update(nowMs);
    },
    configureXrayTargets(targets: readonly LiteXrayTarget[]) {
      if (disposed) return;
      xray.configureTargets(targets);
    },
    setXrayFilter(filter: LiteXrayFilter | null) {
      if (disposed) return;
      xray.setFilter(filter);
    },
    setXRayFilter(filter: LiteXrayFilter | null) {
      if (disposed) return;
      xray.setFilter(filter);
    },
    setCutPlane,
    setWaferPoint(x: number, y: number, z: number, visible: boolean,
      focusOrRotationY?: boolean | number, rotationY?: number) {
      if (disposed) return;
      wafer.setPoint(x, y, z, visible, focusOrRotationY, rotationY);
    },
    setWaferTrail(points: readonly (readonly [number, number, number])[]) {
      if (disposed) return;
      wafer.setTrail(points);
    },
    bindShadows(generator: ShadowGenerator) {
      if (disposed) return;
      xray.bindShadows(generator);
    },
    get shadowLinked() { return xray.shadowLinked; },
    get targetCounts() { return xray.targetCounts; },
    dispose,
  };
}
