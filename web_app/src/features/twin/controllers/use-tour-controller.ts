import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ORIGINAL_TOUR_STOPS as TOUR_STOPS } from '../../../domain/simulation/original-tour';
import { buildTourScenario, TOUR_INITIAL_CAMERA, TOUR_INITIAL_TARGET } from '../../../domain/simulation/tour-scenario';
import { createTourTimeline, type TourFrame, type TourTimeline } from '../../../domain/simulation/tour-timeline';
import { twinUiActions } from '../state/twinUiStore';
import type { FabViewportHandle } from '../fab-viewer';
import type { TourHudSnapshot, TwinTourHudHandle } from '../twin-tour-hud';
import type { TwinLanguage } from '../twin-i18n';

/**
 * Injectable frame scheduler + monotonic clock. Production defaults to
 * window.requestAnimationFrame + performance.now(); tests substitute a virtual
 * clock so the ~60 Hz catch-up loop is deterministic instead of wall-clock.
 */
export interface TwinTourScheduler {
  /** Returns a cancellable frame handle, mirroring window.requestAnimationFrame. */
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  /** Monotonic time in milliseconds. */
  now(): number;
}

const browserScheduler: TwinTourScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};

export interface TwinTourControllerParams {
  scene: RefObject<FabViewportHandle | null>;
  language: TwinLanguage;
  /** Frame scheduler/clock; defaults to window.requestAnimationFrame + performance.now. */
  scheduler?: TwinTourScheduler;
  /**
   * Identity of the owning scene (selected FAB + viewer epoch). A change stops
   * the running tour because its camera/HUD writes belong to the old viewer.
   */
  scopeKey?: string;
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
  /** Manual camera input stops the tour; no-op when the controller is IDLE. */
  cancelTourIfRunning(): void;
}

/** Explicit single-owner lifecycle: never two loops, never a late frame into a new timeline. */
type TourLifecycle = 'IDLE' | 'RUNNING' | 'STOPPING';

/** One animation loop owns exactly one timeline instance and one generation token. */
interface TourSession {
  readonly generation: number;
  readonly timeline: TourTimeline;
  readonly frameMs: number;
  rafHandle: number | null;
  lastFrameMs: number;
  accumulatedMs: number;
}

/**
 * Cinematic-tour controller. The timeline, its RAF loop, the waypoint index and
 * the HUD seed live in refs/one latching state value so the ~60 Hz tour frames
 * never rerender TwinContent/FabViewport; only the HUD child state updates.
 *
 * Ownership contract:
 * - one explicit lifecycle (IDLE/RUNNING/STOPPING); startTour() is
 *   stop-then-restart, so repeated starts can never stack two RAF loops;
 * - every frame callback is bound to its generation token AND its own timeline
 *   instance, so late/duplicate frames from a stopped loop are ignored;
 * - every termination path (HUD end/finish, manual camera input, wafer start,
 *   FAB/viewer scope change, page unmount) goes through the single stop().
 */
export function useTourController({
  scene,
  language,
  scheduler = browserScheduler,
  scopeKey,
}: TwinTourControllerParams): TwinTourController {
  const sessionRef = useRef<TourSession | null>(null);
  const lifecycleRef = useRef<TourLifecycle>('IDLE');
  const generationRef = useRef(0);
  const tourIndexRef = useRef(-1);
  const tourHudRef = useRef<TwinTourHudHandle>(null);
  const [tourHudSeed, setTourHudSeed] = useState<TourHudSnapshot | null>(null);
  const previousScopeRef = useRef(scopeKey);

  function applyTourStep(index: number): void {
    const tourStop = TOUR_STOPS[index];
    if (tourStop) twinUiActions.tourStep({ waypoint: index, level: tourStop.level, view: 'iso' });
  }

  function syncTourHud(frame: TourFrame): void {
    // The tour card owns its high-frequency state; pushing frames through the
    // ref handle keeps the ~60 Hz countdown/progress updates out of TwinContent.
    tourHudRef.current?.setHud({ tag: frame.hudTag, timerText: frame.timerText, progressWidth: frame.progressWidth, activeDot: frame.activeDot });
  }

  /**
   * Unified teardown for every termination path. Idempotent: it invalidates the
   * current generation first, then cancels the owned RAF, stops the owned
   * timeline, clears the HUD and drops the session reference.
   *
   * Identity contract: teardown is captured together with its scheduler. The
   * callback identity only changes when the scheduler changes, so effects may
   * depend on it without rerunning every render, and a replaced scheduler always
   * tears down the session it actually owns (never a late first-render closure).
   */
  const stop = useCallback((): void => {
    if (lifecycleRef.current === 'IDLE') return;
    lifecycleRef.current = 'STOPPING';
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      if (session.rafHandle !== null) scheduler.cancelFrame(session.rafHandle);
      session.rafHandle = null;
      session.timeline.stop();
    }
    tourIndexRef.current = -1;
    tourHudRef.current?.setHud(null);
    setTourHudSeed(null);
    twinUiActions.tourStop();
    lifecycleRef.current = 'IDLE';
  }, [scheduler]);

  /** A frame may run only while its generation owns the running session. */
  function isCurrent(session: TourSession): boolean {
    return lifecycleRef.current === 'RUNNING'
      && sessionRef.current === session
      && generationRef.current === session.generation;
  }

  function step(session: TourSession): void {
    // A frame delivered after stop()/restart is stale even when the browser could
    // not cancel it in time: the shared ref being non-null is not ownership.
    if (!isCurrent(session)) return;
    session.rafHandle = null;
    const now = scheduler.now();
    // The frozen controller advances on 60 Hz RAF ticks. Under a slower compositor,
    // catch up the missed virtual frames so the tour keeps source wall-clock timing.
    session.accumulatedMs += Math.max(0, now - session.lastFrameMs);
    session.lastFrameMs = now;
    const advanceCount = Math.min(8, Math.floor(session.accumulatedMs / session.frameMs));
    if (advanceCount > 0) {
      session.accumulatedMs = Math.max(0, session.accumulatedMs - advanceCount * session.frameMs);
      for (let count = 0; count < advanceCount; count += 1) {
        session.timeline.step();
        if (!session.timeline.readFrame().active) { stop(); return; }
        if (!isCurrent(session)) return;
      }
    }
    const frame = session.timeline.readFrame();
    if (frame.index !== tourIndexRef.current) {
      tourIndexRef.current = frame.index;
      applyTourStep(frame.index);
    }
    scene.current?.setCameraPose([frame.camera.x, frame.camera.y, frame.camera.z], [frame.target.x, frame.target.y, frame.target.z], 0);
    syncTourHud(frame);
    // A store subscriber (Escape/Stop/scope teardown) may have stopped the tour
    // synchronously while applying the waypoint/camera; never revive the loop.
    if (!isCurrent(session)) return;
    session.rafHandle = scheduler.requestFrame(() => step(session));
  }

  function finishTour(): void {
    stop();
  }

  function startTour(): void {
    // Explicit stop-then-restart: a repeated start never stacks a second animation
    // loop (which would advance one timeline twice and leak the old RAF).
    if (lifecycleRef.current !== 'IDLE') stop();
    // The frozen controller tweens from the current camera pose, exactly like
    // tweenCamera in startCinematicTour.
    const camera = scene.current?.getCameraPose();
    const scenario = buildTourScenario(TOUR_STOPS, language, {
      camera: camera ? { x: camera.position[0], y: camera.position[1], z: camera.position[2] } : TOUR_INITIAL_CAMERA,
      target: camera ? { x: camera.target[0], y: camera.target[1], z: camera.target[2] } : TOUR_INITIAL_TARGET,
    });
    const timeline = createTourTimeline(scenario);
    generationRef.current += 1;
    const session: TourSession = {
      generation: generationRef.current,
      timeline,
      frameMs: scenario.frameMs,
      rafHandle: null,
      lastFrameMs: scheduler.now(),
      accumulatedMs: 0,
    };
    sessionRef.current = session;
    lifecycleRef.current = 'RUNNING';
    tourIndexRef.current = -1;
    timeline.start();
    applyTourStep(0);
    setTourHudSeed({ tag: TOUR_STOPS[0].tag, timerText: '5s', progressWidth: '100%', activeDot: 0 });
    session.rafHandle = scheduler.requestFrame(() => step(session));
  }

  function endTour(): void {
    stop();
  }

  function advanceTour(): void {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    if (tourIndexRef.current >= TOUR_STOPS.length - 1) { stop(); return; }
    session.timeline.next();
  }

  function previousTour(): void {
    const session = sessionRef.current;
    if (!session || !isCurrent(session)) return;
    session.timeline.prev();
  }

  /** Manual camera input stops the tour; identity follows the owned stop(). */
  const cancelTourIfRunning = useCallback((): void => {
    if (lifecycleRef.current !== 'IDLE') stop();
  }, [stop]);

  // Page unmount releases the loop/timeline/HUD through the same stop(). The
  // cleanup captures the stop identity (and therefore the scheduler) of the
  // render it belongs to; replacing the scheduler terminates the old session.
  useEffect(() => () => stop(), [stop]);

  // FAB switch or viewer recreation invalidates every frame the old scene owns.
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    stop();
    // stop() only reads refs; the scopeKey transition is the actual trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  return { tourHudRef, tourHudSeed, startTour, endTour, advanceTour, previousTour, finishTour, cancelTourIfRunning };
}
