import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from '../../../domain/simulation/original-tour';
import { buildTourScenario, TOUR_INITIAL_CAMERA, TOUR_INITIAL_TARGET } from '../../../domain/simulation/tour-scenario';
import { createTourTimeline, type TourFrame, type TourTimeline } from '../../../domain/wafer/tour-wafer-timeline';
import { twinUiActions } from '../state/twinUiStore';
import type { FabViewportHandle } from '../fab-viewer';
import type { TourHudSnapshot, TwinTourHudHandle } from '../twin-tour-hud';
import type { TwinLanguage } from '../twin-i18n';

export interface TwinTourControllerParams {
  scene: RefObject<FabViewportHandle | null>;
  language: TwinLanguage;
}

export interface TwinTourController {
  /** Ref handle for the ~60 Hz tour HUD push. */
  tourHudRef: RefObject<TwinTourHudHandle | null>;
  /** Mount-time HUD seed; later frames are pushed through tourHudRef. */
  tourHudSeed: TourHudSnapshot | null;
  startTour(): void;
  endTour(): void;
  advanceTour(): void;
  previousTour(): void;
  finishTour(): void;
  /** Camera interaction stops the tour; false when no controller is running. */
  cancelTourIfRunning(): void;
}

/**
 * Cinematic-tour controller. The timeline, its RAF loop, the waypoint index and
 * the HUD seed live in refs/one latching state value so the ~60 Hz tour frames
 * never rerender TwinContent/FabViewport; only the HUD child state updates.
 */
export function useTourController({ scene, language }: TwinTourControllerParams): TwinTourController {
  const tourTimelineRef = useRef<TourTimeline | null>(null);
  const tourLoopRef = useRef<number | null>(null);
  const tourIndexRef = useRef(-1);
  const tourHudRef = useRef<TwinTourHudHandle>(null);
  const [tourHudSeed, setTourHudSeed] = useState<TourHudSnapshot | null>(null);

  function applyTourStep(index: number): void {
    const stop = TOUR_STOPS[index];
    if (stop) twinUiActions.tourStep({ waypoint: index, level: stop.level, view: 'iso' });
  }

  function syncTourHud(frame: TourFrame): void {
    // The tour card owns its high-frequency state; pushing frames through the
    // ref handle keeps the ~60 Hz countdown/progress updates out of TwinContent.
    tourHudRef.current?.setHud({ tag: frame.hudTag, timerText: frame.timerText, progressWidth: frame.progressWidth, activeDot: frame.activeDot });
  }

  function finishTour(): void {
    if (tourLoopRef.current !== null) { cancelAnimationFrame(tourLoopRef.current); tourLoopRef.current = null; }
    tourTimelineRef.current?.stop();
    tourTimelineRef.current = null;
    tourIndexRef.current = -1;
    setTourHudSeed(null);
    twinUiActions.tourStop();
  }

  function startTour(): void {
    // The frozen controller tweens from the current camera pose, exactly like
    // tweenCamera in startCinematicTour.
    const camera = scene.current?.getCameraPose();
    const controller = createTourTimeline(buildTourScenario(TOUR_STOPS, language, {
      camera: camera ? { x: camera.position[0], y: camera.position[1], z: camera.position[2] } : TOUR_INITIAL_CAMERA,
      target: camera ? { x: camera.target[0], y: camera.target[1], z: camera.target[2] } : TOUR_INITIAL_TARGET,
    }));
    tourTimelineRef.current = controller;
    tourIndexRef.current = -1;
    controller.start();
    applyTourStep(0);
    setTourHudSeed({ tag: TOUR_STOPS[0].tag, timerText: '5s', progressWidth: '100%', activeDot: 0 });
    const frameMs = 1000 / 60;
    let lastFrameMs = performance.now();
    let accumulatedMs = 0;
    const step = (): void => {
      const active = tourTimelineRef.current;
      if (!active) return;
      // The frozen controller advances on 60 Hz RAF ticks. Under a slower compositor,
      // catch up the missed virtual frames so the tour keeps source wall-clock timing.
      const now = performance.now();
      accumulatedMs += Math.max(0, now - lastFrameMs);
      lastFrameMs = now;
      const advanceCount = Math.min(8, Math.floor(accumulatedMs / frameMs));
      if (advanceCount > 0) {
        accumulatedMs = Math.max(0, accumulatedMs - advanceCount * frameMs);
        for (let count = 0; count < advanceCount; count += 1) {
          active.step();
          if (!active.readFrame().active) { finishTour(); return; }
        }
      }
      const frame = active.readFrame();
      if (frame.index !== tourIndexRef.current) {
        tourIndexRef.current = frame.index;
        applyTourStep(frame.index);
      }
      scene.current?.setCameraPose([frame.camera.x, frame.camera.y, frame.camera.z], [frame.target.x, frame.target.y, frame.target.z], 0);
      syncTourHud(frame);
      tourLoopRef.current = requestAnimationFrame(step);
    };
    tourLoopRef.current = requestAnimationFrame(step);
  }

  function endTour(): void {
    finishTour();
  }

  function advanceTour(): void {
    const controller = tourTimelineRef.current;
    if (!controller) return;
    if (tourIndexRef.current >= TOUR_STOPS.length - 1) { finishTour(); return; }
    controller.next();
  }

  function previousTour(): void {
    tourTimelineRef.current?.prev();
  }

  function cancelTourIfRunning(): void {
    if (tourTimelineRef.current) finishTour();
  }

  useEffect(() => () => {
    if (tourLoopRef.current !== null) cancelAnimationFrame(tourLoopRef.current);
    tourTimelineRef.current?.stop();
  }, []);

  return { tourHudRef, tourHudSeed, startTour, endTour, advanceTour, previousTour, finishTour, cancelTourIfRunning };
}
