import type { OriginalTourStop } from './original-tour';
import type { TourScenario, TourWaypoint, Vec3 } from './tour-wafer-timeline';

/** Frozen startCinematicTour baseline camera (source switchFabLevel('L1')/ISO view). */
export const TOUR_INITIAL_CAMERA: Vec3 = { x: 38, y: 48, z: 58 };
export const TOUR_INITIAL_TARGET: Vec3 = { x: 0, y: 0, z: 0 };
export const TOUR_INITIAL_LEVEL = 'L1';
export const TOUR_FRAME_MS = 1000 / 60;
export const TOUR_COUNTDOWN_MS = 100;

/** Maps the frozen CINEMATIC_WAYPOINTS literal onto the pure controller scenario. */
export function buildTourScenario(
  stops: readonly OriginalTourStop[],
  language: 'zh' | 'en',
  initial: { readonly camera: Vec3; readonly target: Vec3 },
): TourScenario {
  const waypoints: TourWaypoint[] = stops.map((stop, index) => ({
    index: index + 1,
    level: stop.level,
    cameraPos: { x: stop.position[0], y: stop.position[1], z: stop.position[2] },
    lookAt: { x: stop.target[0], y: stop.target[1], z: stop.target[2] },
    durationMs: stop.durationMs,
    holdDurationMs: stop.holdMs,
    tag: stop.tag,
    titleZh: stop.title,
    titleEn: stop.titleEn,
    descZh: stop.subtitle,
    descEn: stop.subtitleEn,
  }));
  return {
    clockStartMs: 0,
    frameMs: TOUR_FRAME_MS,
    countdownIntervalMs: TOUR_COUNTDOWN_MS,
    initialCamera: { ...initial.camera },
    initialTarget: { ...initial.target },
    initialLevel: TOUR_INITIAL_LEVEL,
    waypoints,
    hudLanguage: language === 'zh' ? 'zh-CN' : 'en',
  };
}
