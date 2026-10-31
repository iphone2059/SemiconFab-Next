import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { waferRoutesDefinition } from '@/api/wafer.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import type { WaferProduct } from '@/domain/wafer-route';
import { twinUiAtom, twinUiActions } from '@/twin/twin-ui.atom';
import { twinWaferActions, twinWaferAtom } from '@/twin/twin-wafer.atom';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import type { TwinLanguage } from '@/twin/twin-i18n';
import { browserTwinWaferScheduler, registerTwinWaferRuntime, TwinWaferRuntime } from '@/twin/twin-wafer-runtime';
import type { TwinWaferScheduler } from '@/twin/twin-wafer-runtime';
import type { TwinWaferSpeed } from '@/twin/twin-wafer.machine';
export interface TwinWaferPlaybackParams {
  readonly scene: RefObject<FabViewportHandle | null>;
  readonly waferActive: boolean;
  readonly language: TwinLanguage;
  readonly endTour(): void;
  readonly scopeKey?: string;
  readonly scheduler?: TwinWaferScheduler;
  readonly t: (text: string, parameters?: readonly unknown[]) => string;
}
export interface TwinWaferPlayback {
  readonly ready: boolean;
  readonly routesReady: boolean;
  readonly error: string;
  startWafer(): void;
  closeWafer(): void;
  replayWafer(): void;
  changeWaferProduct(product: WaferProduct): void;
  toggleWaferPlay(): void;
  setWaferSpeed(speed: TwinWaferSpeed): void;
  clearFollowOnCameraInteraction(): void;
}
export function useWaferPlayback({
  scene,
  waferActive,
  language,
  endTour,
  scopeKey,
  scheduler = browserTwinWaferScheduler,
  t,
}: TwinWaferPlaybackParams): TwinWaferPlayback {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const runtimeRef = useRef<TwinWaferRuntime | null>(null);
  const previousScopeRef = useRef(scopeKey);
  const [ready, setReady] = useState(false);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const waferRoutesView = useResource(appRuntime, waferRoutesDefinition, { enabled: waferActive });
  const waferRoutes = waferRoutesView.data;
  const error = waferRoutesView.isError ? t('路线加载失败') : '';
  useLayoutEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    runtimeRef.current?.close();
  }, [scopeKey]);
  useEffect(() => {
    const runtime = new TwinWaferRuntime({
      appRuntime,
      registry,
      scheduler,
      scene: () => scene.current,
      language,
    });
    runtimeRef.current = runtime;
    const unregister = registerTwinWaferRuntime(registry, runtime);
    setReady(true);
    setRuntimeGeneration(generation => generation + 1);
    return () => {
      runtimeRef.current = null;
      unregister();
      runtime.dispose();
    };
  }, [appRuntime, registry, scheduler, scopeKey]);
  useEffect(() => {
    if (waferRoutes) runtimeRef.current?.setRoutes(waferRoutes);
  }, [waferRoutes, registry, runtimeGeneration]);
  useEffect(() => {
    runtimeRef.current?.setLanguage(language);
  }, [language, registry, runtimeGeneration]);
  function currentRuntime(): TwinWaferRuntime {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error('TwinWaferRuntime is not mounted');
    return runtime;
  }
  function startWafer(): void {
    endTour();
    if (registry.get(twinUiAtom).entryMode === 'research') twinUiActions.modeSet(registry, 'engineer');
    twinUiActions.levelSet(registry, 'L1');
    twinUiActions.onboardingClose(registry);
    currentRuntime().open();
  }
  function closeWafer(): void {
    currentRuntime().close();
    twinUiActions.viewSet(registry, 'iso');
    scene.current?.setView('iso');
  }
  function replayWafer(): void {
    currentRuntime().replay();
  }
  function changeWaferProduct(product: WaferProduct): void {
    currentRuntime().setProduct(product);
  }
  function toggleWaferPlay(): void {
    currentRuntime().togglePlay();
  }
  function setWaferSpeed(speed: TwinWaferSpeed): void {
    currentRuntime().setSpeed(speed);
  }
  function clearFollowOnCameraInteraction(): void {
    if (registry.get(twinWaferAtom).follow) twinWaferActions.followSet(registry, false);
  }
  return {
    ready,
    routesReady: waferRoutes !== undefined,
    error,
    startWafer,
    closeWafer,
    replayWafer,
    changeWaferProduct,
    toggleWaferPlay,
    setWaferSpeed,
    clearFollowOnCameraInteraction,
  };
}
