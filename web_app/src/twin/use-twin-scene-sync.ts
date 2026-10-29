import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { CutAxis, XRayFilter } from '@/contracts/scene.port';
import type { ViewerLifecycle } from '@/state/runtime-store';
import type { FabLevel, TwinView } from '@/twin/twin-state';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import type { TwinLanguage } from '@/twin/twin-i18n';

export interface TwinSceneSyncParams {
  scene: RefObject<FabViewportHandle | null>;
  /** Discrete viewer lifecycle; display copy is never used to decide scene commands. */
  lifecycle: ViewerLifecycle;
  viewerEpoch: string | undefined;
  view: TwinView;
  language: TwinLanguage;
  level: FabLevel;
  basement: boolean;
  exploded: boolean;
  explodePercent: number;
  cutActive: boolean;
  cutAxis: CutAxis;
  cutPosition: number;
  cutInvert: boolean;
  xrayFilter: XRayFilter | null;
  tourActive: boolean;
  /** Stops the running tour controller; no-op when none is running. */
  cancelTourIfRunning(): void;
}

/**
 * Scene synchronization effects: ambient level/spatial modes, the per-viewer
 * preset restore, tour ownership and language. Every mutation goes through the
 * imperative FabViewportHandle, so these effects never hold React state and
 * never introduce a per-frame render.
 */
export function useTwinSceneSync({
  scene,
  lifecycle,
  viewerEpoch,
  view,
  language,
  level,
  basement,
  exploded,
  explodePercent,
  cutActive,
  cutAxis,
  cutPosition,
  cutInvert,
  xrayFilter,
  tourActive,
  cancelTourIfRunning,
}: TwinSceneSyncParams): void {
  // Track the applied preset by viewer epoch: GPU recovery restores the user
  // pose, so only a fresh epoch/reload or a requested view change re-applies it.
  const appliedCameraView = useRef<{ epoch: string | undefined; view: TwinView } | undefined>(undefined);

  useEffect(() => { scene.current?.setLanguage(language); }, [language, lifecycle]);

  useEffect(() => {
    if (lifecycle !== 'ready') return;
    // Restore material state before changing levels, then apply the single active mode.
    scene.current?.setXRayFilter(null);
    scene.current?.setBasement(basement);
    scene.current?.setDual(level === 'DUAL');
    scene.current?.setExplodeFactor(exploded ? explodePercent / 100 : 0, exploded);
    scene.current?.setCutPlane(cutActive, cutAxis, cutPosition, cutInvert);
    scene.current?.setXRayFilter(xrayFilter);
  }, [lifecycle, basement, level, exploded, explodePercent, cutActive, cutAxis, cutPosition, cutInvert, xrayFilter]);

  useEffect(() => {
    if (lifecycle !== 'ready') return;
    // GPU recovery belongs to the same viewport lifetime and restores its user
    // pose. Only a fresh mount/reload or a requested view change applies a preset.
    if (appliedCameraView.current?.epoch !== viewerEpoch || appliedCameraView.current?.view !== view) scene.current?.setView(view);
    appliedCameraView.current = { epoch: viewerEpoch, view };
  }, [lifecycle, view, viewerEpoch]);

  useEffect(() => {
    if (lifecycle !== 'ready') return;
    scene.current?.setTour(tourActive);
    // Escape/mode/level actions can stop Tour through the store without clicking
    // its Stop button. Cancel the controller too, or its next waypoint revives UI.
    if (!tourActive) cancelTourIfRunning();
    // cancelTourIfRunning is stable (identity follows the owned scheduler), so
    // listing it cannot re-run this effect per render while the closure can never
    // be stale.
  }, [lifecycle, tourActive, cancelTourIfRunning]);
}
