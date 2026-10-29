import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { waferRoutesResource } from '@/api/wafer.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import type { WaferProduct } from '@/domain/wafer-route';
import { createWaferTimeline, type WaferHud, type WaferTimeline } from '@/domain/wafer-timeline';
import { buildWaferScenario } from '@/domain/wafer-scenario';
import { localeAtom } from '@/state/locale.atom';
import { twinPageAtom, twinPageActions } from '@/twin/twin-page.atom';
import { twinUiAtom, twinUiActions } from '@/twin/twin-ui.atom';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import type { TwinLanguage } from '@/twin/twin-i18n';
import { closeWaferSession } from '@/twin/twin-wafer-session';

export interface TwinWaferPlaybackParams {
  scene: RefObject<FabViewportHandle | null>;
  waferActive: boolean;
  language: TwinLanguage;
  /** Starting the wafer walk stops any active tour first. */
  endTour(): void;
  t: (text: string, parameters?: readonly unknown[]) => string;
}

export interface TwinWaferPlayback {
  routesReady: boolean;
  /** Localised route-load failure message (empty when there is no error). */
  error: string;
  startWafer(): void;
  closeWafer(): void;
  replayWafer(): void;
  changeWaferProduct(product: WaferProduct): void;
  toggleWaferPlay(): void;
  setWaferSpeed(speed: 1 | 4 | 16): void;
  /** User camera input ends follow mode; no-op when already free. */
  clearFollowOnCameraInteraction(): void;
}

/**
 * Wafer-follow playback controller: one timeline + one RAF across play/pause,
 * speed, follow and locale changes. Frame state is pushed into refs and the page
 * store projection; TwinContent/FabViewport never render per frame. Closing is
 * routed through the explicit closeWaferSession(registry) use case, while this controller
 * owns the renderer cleanup that stores must not touch.
 */
export function useWaferPlayback({ scene, waferActive, language, endTour, t }: TwinWaferPlaybackParams): TwinWaferPlayback {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const waferRoutesView = useResource(appRuntime, waferRoutesResource, { enabled: waferActive });
  const waferTimelineRef = useRef<WaferTimeline | null>(null);
  const waferHudRef = useRef<WaferHud | null>(null);
  const waferRoutes = waferRoutesView.data;
  const waferError = waferRoutesView.isError ? t('路线加载失败') : '';

  // The retained controller belongs to this registry. Release it before the
  // replacement registry's playback or locale effects can project another frame.
  // Closing/reopening playback within one registry keeps its existing timeline.
  useEffect(() => () => {
    waferTimelineRef.current?.close();
    waferTimelineRef.current = null;
    waferHudRef.current = null;
  }, [registry]);

  function syncWaferHud(): void {
    const controller = waferTimelineRef.current;
    if (!controller) return;
    const frame = controller.readFrame();
    if (frame.hud !== waferHudRef.current) {
      waferHudRef.current = frame.hud;
      twinPageActions.waferFrameReceived(registry, { product: frame.product as WaferProduct, index: frame.index,
        hud: frame.hud, completed: controller.readStats().completed });
    }
    if (frame.playing !== registry.get(twinUiAtom).wafer.playing) twinUiActions.waferPlay(registry, frame.playing);
  }

  useEffect(() => {
    if (!waferActive || !waferRoutes) return;
    // Keep one controller and one RAF across play/pause, speed, follow and locale
    // changes. Paused frames still apply the source camera, never a waypoint snap.
    let controller = waferTimelineRef.current;
    if (!controller) {
      controller = createWaferTimeline({
        ...buildWaferScenario(waferRoutes, registry.get(localeAtom).language),
        product: registry.get(twinPageAtom).wafer.product,
      });
      controller.setSpeed(registry.get(twinUiAtom).wafer.speed);
      waferTimelineRef.current = controller;
    }
    controller.open();
    const initial = controller.readFrame();
    scene.current?.setWaferPoint(initial.position.x, initial.position.y, initial.position.z, true, false, initial.rotationY);
    waferHudRef.current = null;
    syncWaferHud();
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      controller.step(Math.max(0, now - last));
      last = now;
      const current = controller.readFrame();
      const { x, y, z } = current.position;
      scene.current?.setWaferPoint(x, y, z, true, false, current.rotationY);
      if (registry.get(twinPageAtom).wafer.follow) {
        scene.current?.setCameraPose([current.camera.x, current.camera.y, current.camera.z], [x, y, z], 0);
      }
      scene.current?.setWaferTrail(controller.readTrailPoints().map(point => [point.x, point.y, point.z]));
      syncWaferHud();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      controller.close();
      scene.current?.setWaferPoint(0, 0, 0, false, false);
      scene.current?.setWaferTrail([]);
    };
  }, [waferActive, waferRoutes, registry]);

  useEffect(() => {
    waferTimelineRef.current?.setLanguage(language === 'zh' ? 'zh-CN' : 'en');
    syncWaferHud();
  }, [language, registry]);

  function startWafer(): void {
    endTour();
    twinUiActions.waferOpen(registry);
  }

  function closeWafer(): void {
    closeWaferSession(registry);
    scene.current?.setWaferPoint(0, 0, 0, false, false);
    scene.current?.setWaferTrail([]);
    scene.current?.setView('iso');
  }

  function replayWafer(): void {
    waferTimelineRef.current?.replay();
    syncWaferHud();
  }

  function changeWaferProduct(product: WaferProduct): void {
    waferTimelineRef.current?.setProduct(product);
    syncWaferHud();
  }

  function toggleWaferPlay(): void {
    waferTimelineRef.current?.togglePlay();
    syncWaferHud();
  }

  function setWaferSpeed(speed: 1 | 4 | 16): void {
    waferTimelineRef.current?.setSpeed(speed);
    twinUiActions.waferSpeedSet(registry, speed);
  }

  function clearFollowOnCameraInteraction(): void {
    if (registry.get(twinPageAtom).wafer.follow) twinPageActions.waferFollowSet(registry, false);
  }

  return {
    routesReady: !!waferRoutes,
    error: waferError,
    startWafer,
    closeWafer,
    replayWafer,
    changeWaferProduct,
    toggleWaferPlay,
    setWaferSpeed,
    clearFollowOnCameraInteraction,
  };
}
