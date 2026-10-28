// Replays the declared scenario in web_app/tests/fixtures/original-personnel-vectors.json
// (generated from the frozen twin.html by the frozen personnel fixture)
// against the pure controller. Both producers round to 6 decimal digits, which is
// the only declared float tolerance; every compared value is then exact.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  AIR_SHOWERS,
  AIR_SHOWER_BLOW_START_SECONDS,
  PATROL_WAYPOINTS,
  PERSONNEL,
  PURGE_SECONDS,
  VORTEX_PARTICLE_COUNT,
  createPersonnelTimeline,
  type ChamberUserDataMode,
  type PersonnelFrame,
  type PersonnelScenario,
  type PersonnelTimeline,
} from '../../src/domain/personnel/personnel-timeline';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/original-personnel-vectors.json', import.meta.url), 'utf8'),
);

const round = (value: number, digits = 6): number => Math.round(value * 10 ** digits) / 10 ** digits + 0;

const manifest = JSON.parse(
  readFileSync(
    new URL('../fixtures/twin-source-manifest.json', import.meta.url),
    'utf8',
  ),
);

const MODES: ChamberUserDataMode[] = ['as-built', 'preserved'];

function scenarioFor(mode: ChamberUserDataMode): PersonnelScenario {
  return {
    seed: fixture.scenario.seed,
    dt: fixture.scenario.dt,
    clockStartMs: fixture.scenario.clockStartMs,
    clockMsPerTick: fixture.scenario.clockMsPerTick,
    ticks: fixture.scenario.ticks,
    chamberUserDataMode: mode,
  };
}

/** The frozen acceptance vectors include the full diagnostic trace, so they opt in explicitly. */
function tracedScenarioFor(mode: ChamberUserDataMode): PersonnelScenario {
  return { ...scenarioFor(mode), trace: { enabled: true } };
}

interface PurgeFrame {
  tick: number;
  time: number;
  patrol: { phase: string; stateTimer: number; statusKey: string };
  airShowers: PersonnelFrame['airShowers'];
  vortexOpacity: number;
}

interface VortexSample {
  tick: number;
  opacity: number;
  particles: number[][];
}

interface Replay {
  timeline: PersonnelTimeline;
  initialFrame: PersonnelFrame;
  frames: PersonnelFrame[];
  purgeFrames: PurgeFrame[];
  vortexSamples: VortexSample[];
}

function projectPurgeFrame(frame: PersonnelFrame): PurgeFrame {
  return {
    tick: frame.tick,
    time: frame.time,
    patrol: {
      phase: frame.patrol.phase,
      stateTimer: frame.patrol.stateTimer,
      statusKey: frame.patrol.statusKey,
    },
    airShowers: frame.airShowers,
    vortexOpacity: frame.vortexOpacity,
  };
}

function replay(mode: ChamberUserDataMode): Replay {
  const timeline = createPersonnelTimeline(tracedScenarioFor(mode));
  const initialFrame = timeline.readInitialFrame();
  const frames: PersonnelFrame[] = [];
  const purgeFrames: PurgeFrame[] = [];
  const vortexSamples: VortexSample[] = [];
  let purgeTickCount = 0;
  for (let tick = 1; tick <= fixture.scenario.ticks; tick += 1) {
    timeline.step();
    const frame = timeline.readFrame();
    if (frame.patrol.phase === 'AIR_SHOWER_CYCLE') {
      purgeTickCount += 1;
      if (purgeTickCount % fixture.scenario.purgeSampleEvery === 0) {
        purgeFrames.push(projectPurgeFrame(frame));
      }
      if (purgeTickCount % fixture.scenario.vortexSampleEvery === 0) {
        vortexSamples.push({
          tick: frame.tick,
          opacity: frame.vortexOpacity,
          particles: timeline.readVortexParticles().map((particle) => [
            round(particle.angle),
            round(particle.y),
            round(particle.position.x),
            round(particle.position.y),
            round(particle.position.z),
          ]),
        });
      }
    }
    if (tick % fixture.scenario.sampleEvery === 0) frames.push(frame);
  }
  return { timeline, initialFrame, frames, purgeFrames, vortexSamples };
}

it('pins the frozen source hash and line ranges', () => {
  expect(fixture.sourceSha256).toBe(manifest.source_sha256['twin.html']);
  expect(fixture.sourceFunctions).toEqual({
    PATROL_BEHAVIOR_TREE: [9098, 9146],
    createPatrolStatusCanvas: [9148, 9194],
    createPatrolStatusSprite: [9196, 9214],
    updatePatrolStatusSprite: [9216, 9263],
    createAirlockVortexParticles: [9265, 9301],
    createBunnySuitOperator: [9303, 9476],
    buildCleanroomPersonnel: [9478, 9549],
    updatePatrolEngineerBehaviorTree: [9552, 9842],
    drawAirShowerBillboardCanvas: [9935, 10010],
    createAirShowerSprite: [10012, 10032],
    updateAllAirShowerSprites: [10034, 10050],
    createAirShower: [10095, 10257],
  });
  expect(fixture.inlineAnimationBlocks).toEqual({
    personnelBreathing: [19127, 19134],
    airShowerStandbyCycle: [19137, 19206],
  });
});

it('declares the frozen personnel roster, waypoints and air-shower chambers', () => {
  const timeline = createPersonnelTimeline(scenarioFor('as-built'));
  expect(timeline.readPersonnel()).toEqual(fixture.personnel);
  expect(
    PATROL_WAYPOINTS.map((waypoint) => ({
      x: waypoint.x,
      z: waypoint.z,
      targetTool: waypoint.targetTool,
      nameZh: waypoint.nameZh,
      nameEn: waypoint.nameEn,
      duration: waypoint.duration,
      inspectAngle: waypoint.inspectAngle,
    })),
  ).toEqual(fixture.scenario.patrol.waypoints);
  expect(
    AIR_SHOWERS.map((chamber) => ({
      id: chamber.id,
      isAmber: chamber.isAmber,
      position: chamber.position,
      options: {
        width: chamber.width,
        height: chamber.height,
        depth: chamber.depth,
        isAmber: chamber.isAmber,
      },
    })),
  ).toEqual([fixture.scenario.airShowers.main, fixture.scenario.airShowers.litho]);
  expect(PERSONNEL).toHaveLength(fixture.scenario.personnelCount);
  expect(VORTEX_PARTICLE_COUNT).toBe(fixture.scenario.vortexParticleCount);
});

it('reproduces the frozen seeded vortex particles and air-shower construction draws', () => {
  const timeline = createPersonnelTimeline(scenarioFor('as-built'));
  expect(timeline.readVortexInitial()).toEqual(fixture.vortex.initial);
  expect(timeline.readSeedState()).toBe(fixture.modes['as-built'].stats.seedAfter);
  const constructions = timeline.readChamberConstructions();
  const records = fixture.airShowerChambers.records;
  expect(constructions).toHaveLength(records.length);
  constructions.forEach((construction, index) => {
    const record = records[index];
    expect(construction.constructedTimer).toBe(record.timer);
    expect(construction.height).toBe(record.height);
    expect(construction.isAmber).toBe(record.isAmber);
    expect(construction.indicators).toEqual(record.indicators);
    expect(construction.jets).toEqual(
      record.jets.map(
        (jet: {
          opacity: number;
          color: number;
          blending: number;
          position: { x: number; y: number; z: number };
        }) => ({
          opacity: jet.opacity,
          color: jet.color,
          blending: jet.blending,
          position: jet.position,
        }),
      ),
    );
    expect(construction.innerLight).toEqual(record.innerLight);
    expect(construction.labelSprite).toEqual({
      isAmber: record.labelSprite.isAmber,
      scale: record.labelSprite.scale,
      position: record.labelSprite.position,
    });
  });
});

for (const mode of MODES) {
  it('reproduces the frozen ' + mode + ' patrol and air-shower vectors', () => {
    const { timeline, initialFrame, frames, purgeFrames, vortexSamples } = replay(mode);
    const expected = fixture.modes[mode];
    expect(initialFrame).toEqual(expected.initialFrame);
    expect([initialFrame, ...frames]).toEqual(expected.frames);
    expect(purgeFrames).toEqual(expected.purgeFrames);
    expect(vortexSamples).toEqual(expected.vortexSamples);
    expect(timeline.readEvents()).toEqual(expected.events);
    expect(timeline.readPhases()).toEqual(expected.phases);
    expect(timeline.readWaypointTrace()).toEqual(expected.waypointTrace);
    expect(timeline.readStats()).toEqual({
      seedAfter: expected.stats.seedAfter,
      ticks: expected.stats.ticks,
      dt: expected.stats.dt,
      personnel: expected.stats.personnel,
      actors: expected.stats.actors,
      chambers: expected.stats.chambers,
      vortexParticles: expected.stats.vortexParticles,
      events: expected.stats.events,
      phaseChanges: expected.stats.phaseChanges,
      purgeTicks: expected.stats.purgeTicks,
      purgeSeconds: expected.stats.purgeSeconds,
      purges: expected.stats.purges,
      waypointsReached: expected.stats.waypointsReached,
      lastTick: expected.stats.lastTick,
    });
  });
}

it('asserts the frozen 4.5 s purge and the six-phase patrol order', () => {
  const phases = [
    'APPROACH_AIRLOCK',
    'ENTER_AIRLOCK',
    'AIR_SHOWER_CYCLE',
    'EXIT_TO_LITHO',
    'PATROL_WAYPOINTS',
    'RETURN_AIRLOCK',
  ];
  const dt = fixture.scenario.dt;
  for (const mode of MODES) {
    const { timeline, initialFrame } = replay(mode);
    const summary = timeline.readPhases();
    expect(PURGE_SECONDS).toBe(fixture.scenario.purgeSeconds);
    expect(summary.purges).toHaveLength(1);
    const purge = summary.purges[0];
    expect(purge.seconds).toBeGreaterThanOrEqual(PURGE_SECONDS);
    expect(purge.seconds).toBeLessThan(PURGE_SECONDS + 2 * dt);
    expect(purge.lastStateTimer).toBeGreaterThanOrEqual(PURGE_SECONDS - dt);
    expect(purge.lastStateTimer).toBeLessThan(PURGE_SECONDS);
    const observed = [initialFrame.patrol.phase, ...summary.sequence];
    expect(observed.slice(0, phases.length)).toEqual(phases);
    expect(observed.slice(phases.length)).toEqual(['APPROACH_AIRLOCK']);
    expect(new Set(observed)).toEqual(new Set(phases));
    expect(summary.purgeTicks).toBe(purge.ticks);
    expect(summary.ticks.AIR_SHOWER_CYCLE).toBe(summary.purgeTicks);
    expect(purge.ticksInState).toBe(purge.ticks);
  }
});

it('keeps the frozen as-built userData-overwrite dead paths and the preserved animation math', () => {
  const asBuilt = replay('as-built');
  for (const frame of [asBuilt.initialFrame, ...asBuilt.frames]) {
    expect(frame.patrol.legs).toEqual({ left: 0, right: 0 });
    expect(frame.patrol.arms).toEqual({ left: 0, right: 0 });
    expect(frame.patrol.statusSpriteY).toBe(2.15);
    expect(frame.patrol.screenColor).toBe(0x38bdf8);
    for (const chamber of frame.airShowers) {
      expect(chamber.timer).toBeNull();
      expect(chamber.indicator).toEqual({ color: 0x10b981, emissive: 0x10b981, intensity: 0.8 });
      for (const jet of chamber.jets) expect(jet.opacity).toBe(0);
      expect(chamber.innerLight).toBe(0.4);
      expect(chamber.labelSpriteY).toBe(4.0);
    }
  }

  const preserved = replay('preserved');
  const purgeFrames = preserved.frames.filter((frame) => frame.patrol.phase === 'AIR_SHOWER_CYCLE');
  expect(purgeFrames.length).toBeGreaterThan(0);
  for (const frame of purgeFrames) {
    const litho = frame.airShowers[1];
    expect(litho.isPurging).toBe(true);
    expect(frame.vortexOpacity).toBe(0.85);
    expect(frame.patrol.screenColor).toBe(0xf59e0b);
    expect([0xef4444, 0xf59e0b]).toContain(litho.indicator.color);
    expect(litho.indicator.intensity === 1.8 || litho.indicator.intensity === 0.3).toBe(true);
    for (const jet of litho.jets) {
      expect(jet.opacity).toBeGreaterThanOrEqual(0.7);
      expect(jet.opacity).toBeLessThanOrEqual(1.0);
      expect(jet.scale).toBeGreaterThanOrEqual(0.9);
    }
  }
  const blowing = preserved.frames.some((frame) =>
    frame.airShowers.some((chamber) => chamber.cycleBlowing && !chamber.isPurging),
  );
  expect(blowing).toBe(true);
  const bobbing = preserved.frames.filter(
    (frame) => Math.abs(frame.airShowers[0].labelSpriteY - 4.0) > 1e-6,
  );
  expect(bobbing.length).toBeGreaterThan(0);
  expect(AIR_SHOWER_BLOW_START_SECONDS).toBe(fixture.scenario.airShowerBlowStartSeconds);
});

it('keeps the declared zh/en status texts of the frozen behavior tree', () => {
  const { timeline } = replay('preserved');
  const events = timeline.readEvents();
  const phases = events.filter((event) => event.type === 'patrol-phase');
  expect(phases.map((event) => event.to)).toEqual([
    'ENTER_AIRLOCK',
    'AIR_SHOWER_CYCLE',
    'EXIT_TO_LITHO',
    'PATROL_WAYPOINTS',
    'RETURN_AIRLOCK',
    'APPROACH_AIRLOCK',
  ]);
  expect(phases[0].statusTextZh).toBe('正在步向黄光风淋气闸');
  expect(phases[0].statusTextEn).toBe('Approaching Litho Airlock Entry');
  expect(phases[1].statusTextZh).toBe('步入洁净风淋气闸·双门互锁');
  expect(phases[1].statusTextEn).toBe('Entering Airlock · Interlock Engaged');
  expect(phases[2].statusTextZh).toBe('高速除尘吹淋中 28 m/s (0.0s)');
  expect(phases[2].statusTextEn).toBe('HEPA Air Purging 28 m/s (0.0s)');
  expect(phases[3].statusTextEn).toBe('Purge Complete · Safe Green · Entering Litho');
  expect(phases[4].statusTextZh).toBe('巡检 黄光关键尺寸 CD-SEM 量测机 (0.0s)');
  expect(phases[5].statusTextZh).toBe('黄光区巡检完成·步出风淋气闸返回主通道');

  const boardEn = fixture.statusBoards.initialEn
    .filter((op: unknown[]) => op[0] === 'fillText')
    .map((op: unknown[]) => op[1]);
  const boardZh = fixture.statusBoards.initialZh
    .filter((op: unknown[]) => op[0] === 'fillText')
    .map((op: unknown[]) => op[1]);
  expect(boardEn).toEqual(['● AUTONOMOUS PATROL', 'Approaching Litho Airlock']);
  expect(boardZh).toEqual(['● AUTONOMOUS PATROL', '正在步向黄光风淋气闸']);
  expect(fixture.modes['as-built'].statusBoardSamples).toEqual([]);
  expect(fixture.modes.preserved.statusBoardSamples.length).toBeGreaterThan(0);
  const purgeBoard = fixture.modes.preserved.statusBoardSamples.find(
    (sample: { statusKey: string }) => sample.statusKey === 'AIR_SHOWER_CYCLE',
  );
  expect(
    purgeBoard.en
      .filter((op: unknown[]) => op[0] === 'fillText')
      .map((op: unknown[]) => op[1]),
  ).toEqual(['⚡ AIR SHOWER PURGE · 28 m/s', 'Entering Airlock · Interlock Engaged']);
});

it('bounds production history by default while keeping cumulative counters (1h run)', () => {
  const timeline = createPersonnelTimeline({ ...scenarioFor('as-built'), ticks: 225_000 });
  const expectedFrames = fixture.modes['as-built'].frames;
  const checkpoints = new Set([1, 60, 3_500, 180_000, 225_000]);
  let previous = { events: 0, phaseChanges: 0, purges: 0 };
  for (let tick = 1; tick <= 225_000; tick += 1) {
    timeline.step();
    // Recording must not change the frozen motion: actor/patrol frames still match the vectors.
    if (tick % fixture.scenario.sampleEvery === 0 && tick <= 3_500) {
      expect(timeline.readFrame()).toEqual(expectedFrames[tick / fixture.scenario.sampleEvery]);
    }
    if (!checkpoints.has(tick)) continue;
    expect(timeline.readEvents()).toEqual([]);
    expect(timeline.readPhases().sequence).toEqual([]);
    expect(timeline.readPhases().purges).toEqual([]);
    const counters = timeline.readTraceCounters();
    expect(counters.traceEnabled).toBe(false);
    expect(counters.traceBounded).toBe(false);
    // Counters are cumulative and monotonic instead of unbounded history arrays.
    expect(counters.events).toBeGreaterThanOrEqual(previous.events);
    expect(counters.phaseChanges).toBeGreaterThanOrEqual(previous.phaseChanges);
    expect(counters.purges).toBeGreaterThanOrEqual(previous.purges);
    previous = { events: counters.events, phaseChanges: counters.phaseChanges, purges: counters.purges };
    const stats = timeline.readStats();
    expect(stats.events).toBe(counters.events);
    expect(stats.phaseChanges).toBe(counters.phaseChanges);
    expect(stats.purges).toBe(counters.purges);
    if (tick >= 3_500) expect(counters.events).toBeGreaterThan(0);
  }
  // Audit-measured 1h production figures (seed42, 16ms): 1888 events / 406 phase changes / 68 purges.
  const counters = timeline.readTraceCounters();
  expect(counters.events).toBe(1_888);
  expect(counters.phaseChanges).toBe(406);
  expect(counters.purges).toBe(68);
  expect([...counters.waypointArrivals]).toEqual([67, 67, 67, 67]);
  expect(timeline.readStats().purgeSeconds).toBe(306.816);
});

it('records the full trace only when explicitly enabled, with one arrival edge per waypoint visit', () => {
  const traced = createPersonnelTimeline({ ...tracedScenarioFor('as-built'), ticks: 7_000 });
  const plain = createPersonnelTimeline({ ...scenarioFor('as-built'), ticks: 7_000 });
  for (let tick = 1; tick <= 7_000; tick += 1) {
    traced.step();
    plain.step();
    // The opt-in recording toggle cannot perturb the frozen personnel state.
    expect(traced.readFrame()).toEqual(plain.readFrame());
  }
  const events = traced.readEvents();
  expect(events.length).toBeGreaterThan(0);
  const reached = events.filter((event) => event.type === 'waypoint-reached');
  const counters = traced.readTraceCounters();
  expect(counters.traceEnabled).toBe(true);
  expect(reached).toHaveLength(8);
  // One cumulative arrival per arrival edge (and therefore one diagnostic event each).
  expect([...counters.waypointArrivals]).toEqual([2, 2, 2, 2]);
  expect(reached.length).toBe(counters.waypointArrivals.reduce((sum, value) => sum + value, 0));
  const perWaypoint = [0, 0, 0, 0];
  for (let index = 0; index < reached.length; index += 1) {
    perWaypoint[reached[index].index!] += 1;
    if (index > 0) expect(reached[index].tick).toBeGreaterThan(reached[index - 1].tick);
  }
  expect(perWaypoint).toEqual([...counters.waypointArrivals]);
  expect(traced.readTraceCounters().events).toBe(events.length);
  expect(traced.readTraceCounters().phaseChanges).toBe(traced.readPhases().sequence.length);
  expect(traced.readTraceCounters().purges).toBe(traced.readPhases().purges.length);
  // Default mode keeps the same cumulative numbers without the arrays.
  expect(plain.readEvents()).toEqual([]);
  expect(plain.readTraceCounters()).toMatchObject({
    events: counters.events,
    phaseChanges: counters.phaseChanges,
    purges: counters.purges,
    waypointArrivals: counters.waypointArrivals,
  });
});

it('bounds an opted-in trace with ring-buffer capacities instead of growing without limit', () => {
  const timeline = createPersonnelTimeline({
    ...scenarioFor('as-built'),
    ticks: 30_000,
    trace: { enabled: true, maxEvents: 12, maxPhaseChanges: 5, maxPurges: 2 },
  });
  for (let tick = 1; tick <= 30_000; tick += 1) timeline.step();
  const phases = timeline.readPhases();
  const counters = timeline.readTraceCounters();
  expect(timeline.readEvents()).toHaveLength(12);
  expect(phases.sequence).toHaveLength(5);
  expect(phases.purges).toHaveLength(2);
  expect(counters.traceBounded).toBe(true);
  // The retained tail is the newest history; cumulative counters keep counting.
  expect(counters.events).toBeGreaterThan(12);
  expect(counters.phaseChanges).toBeGreaterThan(5);
  expect(counters.purges).toBeGreaterThan(2);
  expect(timeline.readEvents()[11].tick).toBeLessThanOrEqual(30_000);
  expect([...counters.waypointArrivals]).toEqual([9, 9, 9, 9]);
});

it('documents the frozen air-shower userData overwrite evidence', () => {
  expect(fixture.airShowerChambers.userDataKeys['as-built']).toEqual([['id'], ['id']]);
  for (const keys of fixture.airShowerChambers.userDataKeys.preserved) {
    expect(keys).toContain('indicators');
    expect(keys).toContain('jetStreams');
    expect(keys).toContain('innerLight');
    expect(keys).toContain('labelSprite');
  }
  expect(fixture.airShowerChambers.personnelUserDataKeys['as-built']).toEqual([
    'isOperator',
    'isPatrolEngineer',
    'role',
  ]);
  expect(fixture.airShowerChambers.personnelUserDataKeys.preserved).toContain('screenMat');
  expect(fixture.airShowerChambers.personnelUserDataKeys.preserved).toContain('statusSprite');
  expect(fixture.airShowerChambers.asBuiltSpriteRedraws).toEqual({ en: [], zhCn: [] });
  expect(fixture.airShowerChambers.preservedSpriteRedraws.en).toHaveLength(2);
  expect(fixture.airShowerChambers.preservedSpriteRedraws.en[0].ops.length).toBeGreaterThan(0);
});
