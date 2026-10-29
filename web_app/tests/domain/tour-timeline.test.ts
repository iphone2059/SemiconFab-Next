// Replays every declared Tour trace from
// web_app/tests/fixtures/original-tour-wafer-vectors.json (generated from the
// frozen twin.html by the frozen motion fixture) against the pure Tour timeline.
// The producer rounds positions to 6 decimals, the only declared float tolerance;
// discrete state and event boundaries are compared exactly. The shared fixture also
// backs the Wafer-follow suite in wafer-timeline.test.ts.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  createTourTimeline,
  type TourFrame,
  type TourScenario,
} from '@/domain/simulation-tour-timeline';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/original-tour-wafer-vectors.json', import.meta.url), 'utf8'),
);

const TOUR_ACTIONS: string[] = fixture.scenario.tour.actions.map((action: { action: string }) => action.action);

function tourScenario(): TourScenario {
  return {
    clockStartMs: fixture.scenario.tour.clockStartMs,
    frameMs: fixture.scenario.tour.frameMs,
    countdownIntervalMs: fixture.scenario.tour.countdownIntervalMs,
    initialCamera: fixture.scenario.tour.initialCamera,
    initialTarget: fixture.scenario.tour.initialTarget,
    initialLevel: fixture.scenario.tour.initialLevel,
    waypoints: fixture.tour.waypoints,
    hudLanguage: fixture.scenario.tour.hudLanguage,
  };
}

interface TourReplay {
  timeline: ReturnType<typeof createTourTimeline>;
  initialFrame: TourFrame;
  frames: TourFrame[];
}

function replayTour(): TourReplay {
  const timeline = createTourTimeline(tourScenario());
  const initialFrame = timeline.readInitialFrame();
  const frames: TourFrame[] = [initialFrame];
  const actions: { atMs: number; action: string }[] = fixture.scenario.tour.actions;
  let actionIndex = 0;
  const applyDueActions = (): void => {
    while (actionIndex < actions.length && actions[actionIndex].atMs === timeline.clockMs) {
      const action = actions[actionIndex].action;
      if (action === 'start') timeline.start();
      else if (action === 'stop') timeline.stop();
      else if (action === 'next') timeline.next();
      else if (action === 'prev') timeline.prev();
      else throw new Error('Unknown tour action: ' + action);
      actionIndex += 1;
    }
  };
  const assertActionNames = (): void => {
    for (const action of actions) {
      if (!TOUR_ACTIONS.includes(action.action)) throw new Error('Unexpected tour action');
    }
  };
  assertActionNames();
  applyDueActions();
  for (;;) {
    timeline.step();
    applyDueActions();
    const frame = timeline.readFrame();
    if (timeline.clockMs % fixture.scenario.tour.sampleEveryMs === 0) frames.push(frame);
    if (!frame.active && actionIndex >= actions.length) {
      const last = frames[frames.length - 1];
      if (last.tick !== frame.tick) frames.push(frame);
      break;
    }
    if (timeline.clockMs > fixture.scenario.tour.maxMs) throw new Error('Tour did not settle');
  }
  return { timeline, initialFrame, frames };
}

it('pins the frozen source hash and declared tour line ranges', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../fixtures/twin-source-manifest.json', import.meta.url), 'utf8'),
  );
  expect(fixture.sourceSha256).toBe(manifest.source_sha256['twin.html']);
  expect(fixture.sourceFunctions.tour).toEqual({
    CINEMATIC_WAYPOINTS: [19361, 19437],
    cancelActiveCameraAnimation: [19310, 19312],
    tweenCamera: [19314, 19351],
    clearTourTimers: [19439, 19448],
    updateTourTimerUI: [19450, 19456],
    setFabLevelQuiet: [19458, 19503],
    playTourWaypoint: [19505, 19578],
    nextTourWaypoint: [19580, 19588],
    prevTourWaypoint: [19590, 19597],
    startCinematicTour: [19599, 19635],
    stopCinematicTour: [19637, 19655],
  });
});

it('declares the five frozen tour waypoints', () => {
  const waypoints = fixture.tour.waypoints;
  expect(waypoints).toHaveLength(5);
  expect(waypoints.map((waypoint: { index: number }) => waypoint.index)).toEqual([1, 2, 3, 4, 5]);
  expect(waypoints.map((waypoint: { durationMs: number }) => waypoint.durationMs)).toEqual([
    2200, 2000, 2000, 2000, 2200,
  ]);
  expect(waypoints.map((waypoint: { holdDurationMs: number }) => waypoint.holdDurationMs)).toEqual([
    5000, 5000, 5000, 5000, 5000,
  ]);
  expect(waypoints.map((waypoint: { level: string }) => waypoint.level)).toEqual([
    'L1', 'L1', 'L1', 'L1', 'B1',
  ]);
  expect(waypoints[0].titleEn).toBe('300mm Cleanroom Grand Aerial Overview');
  expect(waypoints[4].tag).toBe('WAYPOINT 5/5 • SUBFAB UTILITY & FLOW PIPING');
});

it('reproduces the frozen cinematic tour trace exactly', () => {
  const { timeline, initialFrame, frames } = replayTour();
  expect(initialFrame).toEqual(fixture.tour.frames[0]);
  expect(frames).toEqual(fixture.tour.frames);
  expect(timeline.readEvents()).toEqual(fixture.tour.events);
  const stats = fixture.tour.stats;
  expect(timeline.readStats()).toEqual({
    events: stats.events,
    waypointAdvances: stats.waypointAdvances,
    phaseTransitions: stats.phaseTransitions,
    timerUpdates: stats.timerUpdates,
    levelChanges: stats.levelChanges,
    starts: stats.starts,
    stops: stats.stops,
    nexts: stats.nexts,
    prevs: stats.prevs,
    completedAtMs: stats.completedAtMs,
    finalIndex: stats.finalIndex,
    finalActive: stats.finalActive,
    waypointCount: stats.waypointCount,
  });
});

it('asserts the frozen tour tween/hold/countdown timing', () => {
  const { timeline } = replayTour();
  const events = timeline.readEvents();
  const waypoints = fixture.tour.waypoints;
  const frameMs = fixture.scenario.tour.frameMs;
  const holdDurationMs = waypoints[0].holdDurationMs as number;
  const nonTimer = events.filter((event) => event.type !== 'timer');
  const phases = events.filter((event) => event.type === 'phase');
  const holds = phases.filter((event) => event.phase === 'HOLD');

  expect(phases.filter((event) => event.phase === 'TWEEN')).toHaveLength(9);
  expect(holds).toHaveLength(9);
  expect(phases.filter((event) => event.phase === 'IDLE')).toHaveLength(2);
  expect(phases.filter((event) => event.phase === 'IDLE').map((event) => event.timeMs)).toEqual([
    20000, 54216,
  ]);
  expect(phases.map((event) => event.phase).slice(0, 2)).toEqual(['TWEEN', 'HOLD']);

  // Each HOLD starts exactly one tween duration (quantized to the declared frame
  // grid) after the waypoint play / input action; holds that are not interrupted by
  // next/prev/stop last the frozen 5000 ms holdDuration.
  let naturalHolds = 0;
  let interruptedHolds = 0;
  for (const hold of holds) {
    const next = nonTimer.find((event) => event.timeMs > hold.timeMs);
    expect(next).toBeDefined();
    if (!next) continue;
    const waypointEventsBefore = nonTimer.filter(
      (event) => event.type === 'waypoint' && event.timeMs <= hold.timeMs,
    );
    const actionsBefore = nonTimer.filter(
      (event) => event.type === 'action' && event.timeMs <= hold.timeMs,
    );
    const lastWaypoint = waypointEventsBefore[waypointEventsBefore.length - 1];
    const lastAction = actionsBefore[actionsBefore.length - 1];
    const startTime = Math.max(
      lastWaypoint ? lastWaypoint.timeMs : Number.NEGATIVE_INFINITY,
      lastAction ? lastAction.timeMs : Number.NEGATIVE_INFINITY,
    );
    const currentIndex = lastWaypoint ? (lastWaypoint.index as number) : 0;
    const durationMs = waypoints[currentIndex].durationMs as number;
    expect(hold.timeMs - startTime).toBeGreaterThanOrEqual(durationMs);
    expect(hold.timeMs - startTime).toBeLessThanOrEqual(durationMs + frameMs);

    const delta = next.timeMs - hold.timeMs;
    if (delta === holdDurationMs) {
      naturalHolds += 1;
    } else {
      interruptedHolds += 1;
      expect(nonTimer.some((event) => event.type === 'action' && event.timeMs === next.timeMs)).toBe(true);
    }
  }
  expect(naturalHolds).toBe(5);
  expect(interruptedHolds).toBe(4);

  // The frozen 100 ms countdown updates inside every hold only ever reduce.
  for (const hold of holds) {
    const next = nonTimer.find((event) => event.timeMs > hold.timeMs);
    if (!next) continue;
    const widths = events
      .filter((event) => event.type === 'timer' && event.timeMs > hold.timeMs && event.timeMs < next.timeMs)
      .map((event) => Number(String(event.width).replace('%', '')));
    expect(widths.length).toBeGreaterThan(0);
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]).toBeLessThanOrEqual(widths[index - 1]);
    }
  }
  const firstPulses = events
    .filter((event) => event.type === 'timer' && event.timeMs > holds[0].timeMs)
    .slice(0, 3)
    .map((event) => event.timeMs);
  expect(firstPulses).toEqual([holds[0].timeMs + 100, holds[0].timeMs + 200, holds[0].timeMs + 300]);
});

it('does not dereference an empty cinematic tour waypoint list', () => {
  const timeline = createTourTimeline({ ...tourScenario(), waypoints: [] });
  expect(() => {
    timeline.start();
    timeline.step();
    timeline.next();
    timeline.prev();
    timeline.stop();
    timeline.step();
  }).not.toThrow();
  expect(timeline.readFrame().active).toBe(false);
  expect(timeline.readStats().waypointCount).toBe(0);
});
