// Replays every declared Wafer-follow trace from
// web_app/tests/fixtures/original-tour-wafer-vectors.json (generated from the
// frozen twin.html by the frozen motion fixture) against the pure Wafer timeline.
// Both producers round positions to 6 decimals, the only declared float tolerance;
// discrete state and event boundaries are compared exactly. The shared fixture also
// backs the Cinematic Tour suite in tour-timeline.test.ts.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Vec3 } from '../src/domain/math/vec3';
import {
  createWaferTimeline,
  type WaferFrame,
  type WaferScenario,
  type WaferTimeline,
} from '../src/domain/wafer/wafer-timeline';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/original-tour-wafer-vectors.json', import.meta.url), 'utf8'),
);

const round = (value: number, digits = 6): number => Math.round(value * 10 ** digits) / 10 ** digits + 0;
const roundVec = (vec: Vec3): Vec3 => ({ x: round(vec.x), y: round(vec.y), z: round(vec.z) });

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

it('pins the frozen source hash, asset hashes and declared wafer line ranges', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('./fixtures/twin-source-manifest.json', import.meta.url), 'utf8'),
  );
  expect(fixture.sourceSha256).toBe(manifest.source_sha256['twin.html']);
  expect(fixture.assets.routesJson.sha256).toBe(manifest.source_sha256['benchmark/routes.json']);
  expect(fixture.assets.layoutDefault.sha256).toBe(manifest.source_sha256['twin/layout-default.json']);
  expect(fixture.sourceFunctions.wafer).toEqual({
    CATEGORY_BAYS: [12692, 12797],
    WAFER_TOOL_GROUP_TO_CATEGORY: [16572, 16591],
    computeWaferWaypoints: [18066, 18116],
    initProductRoute: [18118, 18120],
    getCatmullRomSplinePoint: [18203, 18221],
    recordWaferTrailPoint: [18223, 18233],
    updateWaferTrailMesh: [18235, 18268],
    clearWaferTrail: [18270, 18276],
    updateWaferFollowFrame: [18278, 18350],
    updateWaferFollowHUD: [18352, 18407],
    toggleWaferPlay: [18503, 18521],
    setWaferSpeed: [18523, 18537],
    replayWaferRoute: [18563, 18583],
    onWaferProductChange: [18585, 18604],
    onWaferRouteFinished: [18606, 18616],
  });
});

it('declares the frozen wafer route data slices', () => {
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

it('tolerates an empty wafer route without dereferencing waypoints', () => {
  const scenario = waferScenarioFor('A', 1);
  const timeline = createWaferTimeline({ ...scenario, products: { A: [] } });
  expect(timeline.readInitialFrame()).toMatchObject({ waypointCount: 0, playing: false, segment: 'complete' });
  expect(() => {
    timeline.step(fixture.scenario.wafer.frameMs);
    timeline.open();
    timeline.step(fixture.scenario.wafer.frameMs);
    timeline.togglePlay();
    timeline.setSpeed(4);
    timeline.step(fixture.scenario.wafer.frameMs);
    timeline.replay();
    timeline.setProduct('missing-product');
    timeline.step(fixture.scenario.wafer.frameMs);
    timeline.close();
  }).not.toThrow();
  const frame = timeline.readFrame();
  expect(frame.waypointCount).toBe(0);
  expect(frame.hud.step).toBe('Step 0/0');
  expect(frame.hud.width).toBe('0.0%');
  expect(Number.isFinite(frame.position.x)).toBe(true);
  expect(timeline.readStats()).toMatchObject({ waypointCount: 0, completed: false });
});

it('recovers a playable product after an empty route', () => {
  const scenario = waferScenarioFor('A', 1);
  const timeline = createWaferTimeline({ ...scenario, products: { ...scenario.products, EMPTY: [] } });
  timeline.setProduct('EMPTY');
  expect(timeline.readFrame()).toMatchObject({ playing: false, waypointCount: 0 });
  timeline.setProduct('B');
  expect(timeline.readFrame().playing).toBe(true);
  expect(timeline.readFrame().waypointCount).toBeGreaterThan(0);
  timeline.step(fixture.scenario.wafer.frameMs);
  expect(Number.isFinite(timeline.readFrame().position.x)).toBe(true);
});
