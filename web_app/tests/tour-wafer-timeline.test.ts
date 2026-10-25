// Replays every declared Tour and Wafer trace from
// web_app/tests/fixtures/original-tour-wafer-vectors.json (generated from the
// frozen twin.html by tools/build_twin_motion_vectors.cjs) against the pure
// controllers. Both producers round positions to 6 decimals, the only declared
// float tolerance; discrete state and event boundaries are compared exactly.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  createTourTimeline,
  createWaferTimeline,
  type TourFrame,
  type TourScenario,
  type Vec3,
  type WaferFrame,
  type WaferScenario,
  type WaferTimeline,
} from '../src/tour-wafer-timeline';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/original-tour-wafer-vectors.json', import.meta.url), 'utf8'),
);

const round = (value: number, digits = 6): number => Math.round(value * 10 ** digits) / 10 ** digits + 0;
const roundVec = (vec: Vec3): Vec3 => ({ x: round(vec.x), y: round(vec.y), z: round(vec.z) });

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

function waferScenarioFor(product: string, speed: number): WaferScenario {
  return {
    clockStartMs: fixture.scenario.wafer.clockStartMs,
    frameMs: fixture.scenario.wafer.frameMs,
    products: fixture.wafer.products,
    product,
    speed,
    initialCamera: fixture.scenario.wafer.initialCamera,
    categoryBays: fixture.scenario.wafer.categoryBays,
    hudLanguage: fixture.scenario.wafer.hudLanguage,
  };
}

interface TrailSample {
  tick: number;
  timeMs: number;
  visible: boolean;
  count: number;
  drawRange: number;
  points: number[][];
}

function captureTrailSample(timeline: WaferTimeline, frame: WaferFrame): TrailSample {
  return {
    tick: frame.tick,
    timeMs: frame.timeMs,
    visible: frame.trailVisible,
    count: frame.trailCount,
    drawRange: frame.drawRange,
    points: timeline.readTrailPoints().map((point) => [round(point.x), round(point.y), round(point.z)]),
  };
}

interface WaferReplay {
  timeline: WaferTimeline;
  initialFrame: WaferFrame;
  frames: WaferFrame[];
  trailSamples: TrailSample[];
}

function replayWaferSpeed(traceName: string): WaferReplay {
  const traceScenario = fixture.scenario.wafer.speedTraces.find(
    (entry: { name: string }) => entry.name === traceName,
  );
  const expected = fixture.wafer.traces[traceName];
  const timeline = createWaferTimeline(waferScenarioFor(fixture.scenario.wafer.traceProduct, traceScenario.speed));
  const initialFrame = timeline.readInitialFrame();
  const frames: WaferFrame[] = [initialFrame];
  const trailSamples: TrailSample[] = [];
  let nextTrailSample = 0;
  for (let tick = 1; ; tick += 1) {
    timeline.step(fixture.scenario.wafer.frameMs);
    const frame = timeline.readFrame();
    if (tick % traceScenario.sampleEveryFrames === 0 || !frame.playing) frames.push(frame);
    const expectedTrail = expected.trailSamples[nextTrailSample];
    if (expectedTrail !== undefined && expectedTrail.tick === tick) {
      trailSamples.push(captureTrailSample(timeline, frame));
      nextTrailSample += 1;
    }
    if (!frame.playing) break;
  }
  return { timeline, initialFrame, frames, trailSamples };
}

function replayWaferControls(): WaferReplay {
  const controls = fixture.scenario.wafer.controls;
  const expected = fixture.wafer.traces.controls;
  const timeline = createWaferTimeline(waferScenarioFor(fixture.scenario.wafer.traceProduct, controls.speed));
  const initialFrame = timeline.readInitialFrame();
  const frames: WaferFrame[] = [initialFrame];
  const trailSamples: TrailSample[] = [];
  let nextTrailSample = 0;
  for (let tick = 1; ; tick += 1) {
    timeline.step(fixture.scenario.wafer.frameMs);
    for (const action of controls.actions) {
      if (action.frame !== tick) continue;
      if (action.action === 'pause' || action.action === 'resume') timeline.togglePlay();
      else if (action.action === 'speed') timeline.setSpeed(action.arg);
      else if (action.action === 'replay') timeline.replay();
      else if (action.action === 'product') timeline.setProduct(action.arg);
      else throw new Error('Unknown wafer action: ' + action.action);
    }
    const frame = timeline.readFrame();
    if (tick % controls.sampleEveryFrames === 0 || !frame.playing) frames.push(frame);
    const expectedTrail = expected.trailSamples[nextTrailSample];
    if (expectedTrail !== undefined && expectedTrail.tick === tick) {
      trailSamples.push(captureTrailSample(timeline, frame));
      nextTrailSample += 1;
    }
    if (frame.segment === 'complete') break;
  }
  return { timeline, initialFrame, frames, trailSamples };
}

function replayWaferStall(): WaferReplay {
  const stall = fixture.scenario.wafer.stall;
  const expected = fixture.wafer.traces.stall;
  const timeline = createWaferTimeline(waferScenarioFor(fixture.scenario.wafer.traceProduct, stall.speed));
  const initialFrame = timeline.readInitialFrame();
  const frames: WaferFrame[] = [initialFrame];
  const trailSamples: TrailSample[] = [];
  let nextTrailSample = 0;
  for (let index = 1; index < stall.frameTimes.length; index += 1) {
    const dtMs = stall.frameTimes[index] - stall.frameTimes[index - 1];
    timeline.step(dtMs);
    const frame = timeline.readFrame();
    frames.push(frame);
    const expectedTrail = expected.trailSamples[nextTrailSample];
    if (expectedTrail !== undefined && expectedTrail.tick === index) {
      trailSamples.push(captureTrailSample(timeline, frame));
      nextTrailSample += 1;
    }
    if (!frame.playing) break;
  }
  return { timeline, initialFrame, frames, trailSamples };
}

it('pins the frozen source, asset hashes and declared line ranges', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../docs/migration/twin-parity/source-manifest.json', import.meta.url), 'utf8'),
  );
  expect(fixture.sourceSha256).toBe(manifest.source_sha256['twin.html']);
  expect(fixture.assets.routesJson.sha256).toBe(manifest.source_sha256['benchmark/routes.json']);
  expect(fixture.assets.layoutDefault.sha256).toBe(manifest.source_sha256['twin/layout-default.json']);
  expect(fixture.sourceFunctions.tour).toEqual({
    CINEMATIC_WAYPOINTS: [19353, 19429],
    cancelActiveCameraAnimation: [19302, 19304],
    tweenCamera: [19306, 19343],
    clearTourTimers: [19431, 19440],
    updateTourTimerUI: [19442, 19448],
    setFabLevelQuiet: [19450, 19495],
    playTourWaypoint: [19497, 19570],
    nextTourWaypoint: [19572, 19580],
    prevTourWaypoint: [19582, 19589],
    startCinematicTour: [19591, 19627],
    stopCinematicTour: [19629, 19647],
  });
  expect(fixture.sourceFunctions.wafer).toEqual({
    CATEGORY_BAYS: [12684, 12789],
    WAFER_TOOL_GROUP_TO_CATEGORY: [16564, 16583],
    computeWaferWaypoints: [18058, 18108],
    initProductRoute: [18110, 18112],
    getCatmullRomSplinePoint: [18195, 18213],
    recordWaferTrailPoint: [18215, 18225],
    updateWaferTrailMesh: [18227, 18260],
    clearWaferTrail: [18262, 18268],
    updateWaferFollowFrame: [18270, 18342],
    updateWaferFollowHUD: [18344, 18399],
    toggleWaferPlay: [18495, 18513],
    setWaferSpeed: [18515, 18529],
    replayWaferRoute: [18555, 18575],
    onWaferProductChange: [18577, 18596],
    onWaferRouteFinished: [18598, 18608],
  });
});

it('declares the five frozen tour waypoints and the frozen wafer route data', () => {
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

  expect(fixture.wafer.routeSource.fullProductSteps).toEqual({ A: 120, B: 104, C: 92 });
  expect(fixture.wafer.routeSource.fullProductWaypointCounts).toEqual({ A: 120, B: 104, C: 92 });
  for (const product of ['A', 'B', 'C']) {
    expect(fixture.wafer.products[product]).toHaveLength(fixture.scenario.wafer.routeSliceSteps);
    for (const waypoint of fixture.wafer.products[product]) {
      expect(typeof waypoint.x).toBe('number');
      expect(waypoint.y).toBe(2.5);
    }
  }
  expect(fixture.wafer.products.A[0]).toEqual({
    step: 1,
    tool_group: 'TG13_WET_BENCH',
    recipe: 'REC_WET_RCA_CLEAN',
    category: 'wet_clean',
    x: -1.5,
    y: 2.5,
    z: 6.5,
  });
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

it('reproduces the frozen 1x/4x/16x wafer speed traces exactly', () => {
  for (const trace of fixture.scenario.wafer.speedTraces) {
    const expected = fixture.wafer.traces[trace.name];
    const { timeline, initialFrame, frames, trailSamples } = replayWaferSpeed(trace.name);
    expect(initialFrame).toEqual(expected.frames[0]);
    expect(frames).toEqual(expected.frames);
    expect(timeline.readEvents()).toEqual(expected.events);
    expect(trailSamples).toEqual(expected.trailSamples);
    const stats = timeline.readStats();
    expect(stats.events).toBe(expected.stats.events);
    expect(stats.speed).toBe(expected.stats.speed);
    expect(stats.stepDurationSeconds).toBe(expected.stats.stepDurationSeconds);
    expect(stats.completed).toBe(expected.stats.completed);
    expect(stats.completionTimeMs).toBe(expected.stats.completionTimeMs);
    expect(stats.finalIndex).toBe(expected.stats.finalIndex);
    expect(stats.waypointCount).toBe(expected.stats.waypointCount);
    expect(stats.trailMax).toBe(expected.stats.trailMax);
    expect(stats.durationMs).toBe(expected.stats.durationMs);
    expect(frames.length).toBe(expected.stats.frames);
  }
});

it('reproduces the frozen play/pause/replay/speed/product-change trace exactly', () => {
  const expected = fixture.wafer.traces.controls;
  const { timeline, initialFrame, frames, trailSamples } = replayWaferControls();
  expect(initialFrame).toEqual(expected.frames[0]);
  expect(frames).toEqual(expected.frames);
  expect(timeline.readEvents()).toEqual(expected.events);
  expect(trailSamples).toEqual(expected.trailSamples);
  const stats = timeline.readStats();
  expect(stats.events).toBe(expected.stats.events);
  expect(stats.completed).toBe(expected.stats.completed);
  expect(stats.completionTimeMs).toBe(expected.stats.completionTimeMs);
  expect(stats.finalIndex).toBe(expected.stats.finalIndex);
  expect(stats.finalProduct).toBe(expected.stats.finalProduct);
  expect(stats.finalSpeed).toBe(expected.stats.finalSpeed);
  expect(stats.waypointCount).toBe(expected.stats.waypointCount);
  expect(stats.trailMax).toBe(expected.stats.trailMax);
  expect(stats.durationMs).toBe(expected.stats.durationMs);
  expect(stats.actionCount).toBe(expected.stats.actions);
});

it('reproduces the frozen dt-clamp stall trace exactly', () => {
  const expected = fixture.wafer.traces.stall;
  const { timeline, initialFrame, frames, trailSamples } = replayWaferStall();
  expect(initialFrame).toEqual(expected.frames[0]);
  expect(frames).toEqual(expected.frames);
  expect(timeline.readEvents()).toEqual(expected.events);
  expect(trailSamples).toEqual(expected.trailSamples);
  const stats = timeline.readStats();
  expect(stats.events).toBe(expected.stats.events);
  expect(stats.completed).toBe(expected.stats.completed);
  expect(stats.speed).toBe(expected.stats.speed);
  expect(stats.finalIndex).toBe(expected.stats.finalIndex);
  expect(stats.trailMax).toBe(expected.stats.trailMax);
  expect(stats.maxObservedDt).toBe(expected.stats.dtClamp);
  expect(stats.stalledFrameIndex).toBe(expected.stats.stalledFrameIndex);
  expect(frames.some((frame) => frame.dt === expected.stats.dtClamp)).toBe(true);
});

it('asserts the frozen 2.0/speed durations, 75/25 split and completion', () => {
  const frameMs = fixture.scenario.wafer.frameMs;
  const route = fixture.wafer.products.A;
  for (const trace of fixture.scenario.wafer.speedTraces) {
    const expected = fixture.wafer.traces[trace.name];
    const steps = expected.stats.waypointCount;
    const nominalDurationMs = steps * (2.0 / trace.speed) * 1000;
    expect(expected.stats.stepDurationSeconds).toBe(2.0 / trace.speed);
    expect(expected.stats.durationMs).toBeGreaterThanOrEqual(nominalDurationMs);
    expect(expected.stats.durationMs).toBeLessThanOrEqual(nominalDurationMs + steps * frameMs);

    const frames: WaferFrame[] = expected.frames;
    expect(frames.some((frame) => frame.segment === 'transit')).toBe(true);
    expect(frames.some((frame) => frame.segment === 'dwell')).toBe(true);
    for (const frame of frames) {
      if (frame.segment === 'transit') expect(frame.progress).toBeLessThan(0.75);
      if (frame.segment === 'dwell') {
        expect(frame.progress).toBeGreaterThanOrEqual(0.75);
        expect(frame.progress).toBeLessThanOrEqual(1);
        const target = route[frame.index];
        expect(frame.position).toEqual(roundVec(target));
      }
    }
    const last = frames[frames.length - 1];
    expect(last.playing).toBe(false);
    expect(last.segment).toBe('complete');
    expect(last.index).toBe(steps - 1);
    expect(expected.events.some((event: { type: string }) => event.type === 'complete')).toBe(true);
  }
});

it('asserts the frozen trail rule: distance > 0.25, max 30 points', () => {
  for (const trace of fixture.scenario.wafer.speedTraces) {
    const samples: { points: number[][]; count: number; visible: boolean; drawRange: number }[] =
      fixture.wafer.traces[trace.name].trailSamples;
    for (const sample of samples) {
      expect(sample.points.length).toBeLessThanOrEqual(30);
      expect(sample.count).toBeLessThanOrEqual(30);
      expect(sample.points.length).toBe(sample.drawRange);
      if (sample.count >= 2) {
        expect(sample.visible).toBe(true);
        expect(sample.drawRange).toBe(sample.count);
      }
      for (let index = 1; index < sample.points.length; index += 1) {
        const previous = sample.points[index - 1];
        const current = sample.points[index];
        expect(Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2])).toBeGreaterThan(0.25);
      }
    }
  }
  const oneX = fixture.wafer.traces.speed1x;
  expect(oneX.stats.trailMax).toBe(30);
  expect(oneX.frames.some((frame: WaferFrame) => frame.trailCount === 30)).toBe(true);
  expect(oneX.frames.some((frame: WaferFrame) => frame.trailCount < 30)).toBe(true);
});

it('asserts the frozen play/pause/replay/product-change semantics', () => {
  const events: {
    type: string;
    action?: string;
    arg?: number | string;
    playing?: boolean;
    index?: number;
    product?: string;
  }[] = fixture.wafer.traces.controls.events;
  const actionSequence = events.filter((event) => event.type === 'action').map((event) => event.action);
  expect(actionSequence).toEqual(['pause', 'resume', 'speed', 'replay', 'product', 'speed']);
  expect(events.some((event) => event.type === 'playing' && event.playing === false)).toBe(true);
  expect(events.some((event) => event.type === 'playing' && event.playing === true)).toBe(true);
  expect(events.some((event) => event.type === 'product' && event.product === 'B')).toBe(true);

  const frames: WaferFrame[] = fixture.wafer.traces.controls.frames;
  const paused = frames.filter((frame) => frame.segment === 'paused');
  expect(paused.length).toBeGreaterThan(1);
  for (const frame of paused) expect(frame.stepTimer).toBe(paused[0].stepTimer);
  const replayIndex = events.findIndex((event) => event.type === 'action' && event.action === 'replay');
  const replayReset = events.slice(replayIndex).find((event) => event.type === 'index');
  expect(replayReset).toBeDefined();
  if (replayReset) expect(replayReset.index).toBe(0);
  const productEvent = events.find((event) => event.type === 'product');
  expect(productEvent).toBeDefined();
  if (productEvent) expect(productEvent.product).toBe('B');
});

it('records that the frozen source has no seek, only replay and speed scaling', () => {
  expect(fixture.wafer.seek.supported).toBe(false);
  expect(fixture.wafer.seek.evidence).toContain('2.0 / speed');
  expect(fixture.wafer.seek.evidence).toContain('replayWaferRoute');
  expect(fixture.stubBoundary.seekAdvance).toContain('no seek');
  expect(fixture.scenario.wafer.speedTraces.map((trace: { speed: number }) => trace.speed)).toEqual([1, 4, 16]);
  expect(fixture.scenario.wafer.speedTraces[2].speed).toBe(16);
  expect(fixture.scenario.wafer.speedTraces[1].speed).toBe(4);
});
