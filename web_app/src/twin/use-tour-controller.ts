import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from '@/domain/simulation-original-tour';
import { twinUiActions } from '@/twin/twin-ui.atom';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import type { TwinTourHudHandle } from '@/twin/twin-tour-hud';
import type { TourHudSnapshot, TwinTourScheduler } from '@/twin/twin-tour-runtime';
import {
  browserTwinTourScheduler,
  registerTwinTourRuntime,
  TwinTourRuntime,
} from '@/twin/twin-tour-runtime';
import type { TwinLanguage } from '@/twin/twin-i18n';
export type { TwinTourScheduler } from '@/twin/twin-tour-runtime';
export interface TwinTourControllerParams {
  readonly scene: RefObject<FabViewportHandle | null>;
  readonly language: TwinLanguage;
  readonly scheduler?: TwinTourScheduler;
  readonly scopeKey?: string;
}
export interface TwinTourController {
  readonly ready: boolean;
  readonly tourHudRef: RefObject<TwinTourHudHandle | null>;
  readonly tourHudSeed: TourHudSnapshot | null;
  startTour(): void;
  endTour(): void;
  advanceTour(): void;
  previousTour(): void;
  finishTour(): void;
  cancelTourIfRunning(): void;
}
export function useTourController({
  scene,
  language,
  scheduler = browserTwinTourScheduler,
  scopeKey,
}: TwinTourControllerParams): TwinTourController {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const runtimeRef = useRef<TwinTourRuntime | null>(null);
  const tourHudRef = useRef<TwinTourHudHandle>(null);
  const previousScopeRef = useRef(scopeKey);
  const [ready, setReady] = useState(false);
  const [tourHudSeed, setTourHudSeed] = useState<TourHudSnapshot | null>(null);
  useEffect(() => {
    const runtime = new TwinTourRuntime({
      appRuntime,
      registry,
      scheduler,
      onHud: hud => tourHudRef.current?.setHud(hud),
      onStopped: () => setTourHudSeed(null),
      onWaypoint: index => {
        const stop = TOUR_STOPS[index];
        if (stop) twinUiActions.tourSceneStep(registry, { level: stop.level, view: 'iso' });
      },
    });
    runtimeRef.current = runtime;
    const unregister = registerTwinTourRuntime(registry, runtime);
    setTourHudSeed(null);
    setReady(true);
    return () => {
      runtimeRef.current = null;
      unregister();
      runtime.dispose();
    };
  }, [appRuntime, registry, scheduler]);
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    runtimeRef.current?.stop();
  }, [scopeKey]);
  function startTour(): void {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error('TwinTourRuntime is not mounted');
    setTourHudSeed(runtime.startTour(() => scene.current, language));
  }
  function endTour(): void {
    runtimeRef.current?.stop();
  }
  function advanceTour(): void {
    runtimeRef.current?.advanceTour();
  }
  function previousTour(): void {
    runtimeRef.current?.previousTour();
  }
  return {
    ready,
    tourHudRef,
    tourHudSeed,
    startTour,
    endTour,
    advanceTour,
    previousTour,
    finishTour: endTour,
    cancelTourIfRunning: endTour,
  };
}
