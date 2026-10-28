import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { CutAxis, XRayFilter } from '../../../rendering/fab-scene';
import type { FabLevel, TwinView } from '../state/twin-state';
import type { FabViewportHandle } from '../fab-viewer';
import type { TwinLanguage } from '../twin-i18n';

export interface TwinSceneSyncParams {
  scene: RefObject<FabViewportHandle | null>;
  status: string;
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
  status,
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

  useEffect(() => { scene.current?.setLanguage(language); }, [language, status]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    // Restore material state before changing levels, then apply the single active mode.
    scene.current?.setXRayFilter(null);
    scene.current?.setBasement(basement);
    scene.current?.setDual(level === 'DUAL');
    scene.current?.setExplodeFactor(exploded ? explodePercent / 100 : 0, exploded);
    scene.current?.setCutPlane(cutActive, cutAxis, cutPosition, cutInvert);
    scene.current?.setXRayFilter(xrayFilter);
  }, [status, basement, level, exploded, explodePercent, cutActive, cutAxis, cutPosition, cutInvert, xrayFilter]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    // GPU recovery belongs to the same viewport lifetime and restores its user
    // pose. Only a fresh mount/reload or a requested view change applies a preset.
    if (appliedCameraView.current?.epoch !== viewerEpoch || appliedCameraView.current?.view !== view) scene.current?.setView(view);
    appliedCameraView.current = { epoch: viewerEpoch, view };
  }, [status, view, viewerEpoch]);

  useEffect(() => {
    if (!status.startsWith('WebGPU')) return;
    scene.current?.setTour(tourActive);
    // Escape/mode/level actions can stop Tour through the store without clicking
    // its Stop button. Cancel the controller too, or its next waypoint revives UI.
    if (!tourActive) cancelTourIfRunning();
  }, [status, tourActive]);
}
