import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { waferRoutesQueryOptions } from '../../../api/queries/wafer.queries';
import type { WaferProduct } from '../../../domain/wafer/wafer-route';
import { createWaferTimeline, type WaferHud, type WaferTimeline } from '../../../domain/wafer/tour-wafer-timeline';
import { buildWaferScenario } from '../../../domain/wafer/wafer-scenario';
import { useLocaleStore } from '../../../state/localeStore';
import { useTwinPageStore, twinPageActions } from '../state/twinPageStore';
import { useTwinUiStore, twinUiActions } from '../state/twinUiStore';
import type { FabViewportHandle } from '../fab-viewer';
import type { TwinLanguage } from '../twin-i18n';
import { closeWaferSession } from '../wafer-session';

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
 * routed through the explicit closeWaferSession() use case, while this controller
 * owns the renderer cleanup that stores must not touch.
 */
export function useWaferPlayback({ scene, waferActive, language, endTour, t }: TwinWaferPlaybackParams): TwinWaferPlayback {
  const waferTimelineRef = useRef<WaferTimeline | null>(null);
  const waferHudRef = useRef<WaferHud | null>(null);
  const waferRoutesQuery = useQuery({ ...waferRoutesQueryOptions(), enabled: waferActive });
  const waferRoutes = waferRoutesQuery.data;
  const waferError = waferRoutesQuery.isError ? t('路线加载失败') : '';

  function syncWaferHud(): void {
    const controller = waferTimelineRef.current;
    if (!controller) return;
    const frame = controller.readFrame();
    if (frame.hud !== waferHudRef.current) {
      waferHudRef.current = frame.hud;
      twinPageActions.waferFrameReceived({ product: frame.product as WaferProduct, index: frame.index,
        hud: frame.hud, completed: controller.readStats().completed });
    }
    if (frame.playing !== useTwinUiStore.getState().wafer.playing) twinUiActions.waferPlay(frame.playing);
  }

  useEffect(() => {
    if (!waferActive || !waferRoutes) return;
    // Keep one controller and one RAF across play/pause, speed, follow and locale
    // changes. Paused frames still apply the source camera, never a waypoint snap.
    let controller = waferTimelineRef.current;
    if (!controller) {
      controller = createWaferTimeline(buildWaferScenario(waferRoutes, useLocaleStore.getState().language));
      controller.setSpeed(useTwinUiStore.getState().wafer.speed);
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
      if (useTwinPageStore.getState().wafer.follow) {
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
  }, [waferActive, waferRoutes]);

  useEffect(() => {
    waferTimelineRef.current?.setLanguage(language === 'zh' ? 'zh-CN' : 'en');
    syncWaferHud();
  }, [language]);

  function startWafer(): void {
    endTour();
    twinUiActions.waferOpen();
  }

  function closeWafer(): void {
    closeWaferSession();
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
    twinUiActions.waferSpeedSet(speed);
  }

  function clearFollowOnCameraInteraction(): void {
    if (useTwinPageStore.getState().wafer.follow) twinPageActions.waferFollowSet(false);
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
