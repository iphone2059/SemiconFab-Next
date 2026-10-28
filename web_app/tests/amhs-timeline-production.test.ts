import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  advanceAmhsState,
  createAmhsRandom,
  createAmhsState,
  AMHS_LED_COLORS,
  AMHS_TRAFFIC_SEED,
  type AmhsLoopId,
  type AmhsTask,
} from '../src/domain/amhs/amhs-timeline';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/original-dynamics-vectors.json', import.meta.url), 'utf8'));

// The renderer's production track/station configuration (rendering/lite/motion.ts):
// source Catmull-Rom loop lengths and the seven stations per loop, 24 vehicles.
const PRODUCTION_LENGTHS: [number, number] = [261.642382244552, 193.47158503491087];
const PRODUCTION_STATIONS: [number[], number[]] = [
  [28, 52.5, 88, 112, 153, 176, 245],
  [0, 28, 55, 86, 112, 132, 162.5],
];
const PRODUCTION_VEHICLES = [1, 2].flatMap((loopId) =>
  Array.from({ length: 12 }, (_, index) => ({
    loopId: loopId as AmhsLoopId,
    s: (index / 12) * PRODUCTION_LENGTHS[loopId - 1],
  })),
);

function station(loopId: AmhsLoopId, s: number, index: number) {
  return { id: `L${loopId}-ST${String(index + 1).padStart(2, '0')}`, loopId, s, bay: '', bayName: '', bayNameZh: '' };
}

function productionScenario() {
  return {
    loops: {
      1: { length: PRODUCTION_LENGTHS[0], stations: PRODUCTION_STATIONS[0].map((s, index) => station(1, s, index)) },
      2: { length: PRODUCTION_LENGTHS[1], stations: PRODUCTION_STATIONS[1].map((s, index) => station(2, s, index)) },
    },
    initialNextTaskTime: 1,
    vehicles: PRODUCTION_VEHICLES,
  };
}

// Frozen vectors captured from the pre-optimisation dispatch/kinematics
// implementation on the production track (seed 42, 60 Hz, 6,000 frames). They
// pin per-vehicle update order, shortest-distance tie-break, no-overtake
// spacing, arrival/dwell timing and completed-task delivery times.
const PRODUCTION_DISPATCH: readonly number[][] = [
  [60, 0, 1, 1, 23.20394852], [133, 1, 0, 1, 3.10375], [206, 2, 21, 2, 149.91077211],
  [368, 3, 20, 2, 137.568140023], [441, 4, 10, 1, 228.325735204], [513, 5, 12, 2, 11.970416667],
  [906, 6, 7, 1, 173.765139643], [978, 7, 4, 1, 110.034544082], [1402, 8, 13, 2, 52.383048753],
  [1678, 9, 17, 2, 119.766910431], [1818, 10, 11, 1, 20.616884813], [1891, 11, 16, 2, 108.614278345],
  [2007, 12, 9, 1, 243.06220335], [2084, 13, 8, 1, 223.055338163], [2546, 14, 23, 2, 43.284451247],
  [3321, 15, 6, 1, 208.311607789], [3454, 16, 19, 2, 193.452174604], [3620, 17, 5, 1, 206.444742602],
  [3897, 18, 4, 1, 189.965416667], [4377, 19, 22, 2, 103.803193438], [4498, 20, 3, 1, 170.364345561],
  [4743, 21, 18, 2, 19.555040816], [4875, 22, 2, 1, 176.024147041], [5643, 23, 17, 2, 17.597164965],
  [5722, 24, 0, 1, 165.912083333], [5795, 25, 8, 1, 93.925], [5916, 26, 11, 1, 147.155416667],
];
const PRODUCTION_COMPLETED: readonly number[][] = [
  [3271, 7, 54.516666667, 38.216666667], [3351, 11, 55.85, 24.333333333],
  [3384, 1, 56.4, 54.183333333], [3534, 9, 58.9, 30.933333333],
  [3578, 8, 59.633333333, 36.266666667], [4431, 0, 73.85, 72.85],
  [4647, 10, 77.45, 47.15], [4907, 13, 81.783333333, 47.05],
  [5217, 4, 86.95, 79.6], [5673, 3, 94.55, 88.416666667],
  [5717, 5, 95.283333333, 86.733333333], [5926, 19, 98.766666667, 25.816666667],
];
const PRODUCTION_SAMPLE_HASHES = [
  '0188b10c', '4810d0cf', '196da46d', '92fd6e38', 'f91b8b24', '2cbf14f2', 'f8236767', 'e9c4ecf4',
  '377cb1b0', 'a67646b4', '99037760', '04aba631', 'c9bdbf3b', '38c0dd3a', '210cb3b4', 'a8262a51',
  '249eccf0', '5df28099', '6a09c665', 'c722a0ec', 'b6bc2e5b', '8550b58e', '782724bc', 'abee78f5',
  'b582d6bd', 'e603ba5a', '76e52e11', 'd342622f', '0c98cb67', '4c8c5491', '17c64223', 'b1de04d1',
  '1f93b19f', 'c1d368db', 'c42df7df', 'e7f1db42', '0addc743', '2ba92bd5', '57d98634', '17008512',
  'd58fa03d', '85e31bdb', '0837bce3', 'fee3d780', '4b1ce0ab', 'a04e06f7', '9ec441d9', '0fff5ae8',
  'e686da8f', '87f1c920',
];

const round = (value: number): number => Number(value.toFixed(9));

/** 32-bit FNV-1a over the compact per-sample payload; any changed field changes the hash. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

function runProductionVectors() {
  const state = createAmhsState(productionScenario(), { retainCompletedHistory: true });
  const random = createAmhsRandom(AMHS_TRAFFIC_SEED).random;
  const dispatch: number[][] = [];
  const completed: number[][] = [];
  const sampleHashes: string[] = [];
  const previousTask = state.vehicles.map((vehicle) => (vehicle.task ? vehicle.task.id : null));
  let completedSeen = 0;
  for (let tick = 1; tick <= 6_000; tick += 1) {
    advanceAmhsState(state, 1 / 60, random);
    for (let id = 0; id < state.vehicles.length; id += 1) {
      const task = state.vehicles[id].task;
      const taskId = task ? task.id : null;
      if (taskId !== null && taskId !== previousTask[id]) {
        dispatch.push([tick, Number(taskId.slice(4)) - 1, id, state.vehicles[id].loopId, round(state.vehicles[id].s)]);
      }
      previousTask[id] = taskId;
    }
    while (completedSeen < state.completedCount) {
      const task = state.completed[completedSeen++];
      completed.push([tick, Number(task.id.slice(4)) - 1, round(task.deliveredAt!), round(task.deliveredAt! - task.createdAt)]);
    }
    if (tick % 120 !== 0) continue;
    const payload = {
      time: round(state.simTime), nextTaskTime: round(state.nextTaskTime), taskSeq: state.taskSeq,
      completed: state.completedCount, totalDeliveryTime: round(state.totalDeliveryTime),
      minObservedGap: Number.isFinite(state.minObservedGap) ? round(state.minObservedGap) : null,
      gapViolations: state.gapViolations, queueLength: state.queue.length,
      queue: state.queue.map((task) => task.id),
      vehicles: state.vehicles.map((vehicle) => [round(vehicle.s), round(vehicle.speed), vehicle.state,
        vehicle.task ? vehicle.task.id : null, vehicle.targetStation ? vehicle.targetStation.id : null,
        round(vehicle.dwellTimer), round(vehicle.hoistY), round(vehicle.cableScaleY), round(vehicle.cableY),
        vehicle.foupVisible ? 1 : 0, vehicle.ledHex]),
    };
    sampleHashes.push(fnv(JSON.stringify(payload)));
  }
  return { state, dispatch, completed, sampleHashes };
}

it('keeps the frozen production-track AMHS vectors after the dispatch fast path', () => {
  const { dispatch, completed, sampleHashes } = runProductionVectors();
  expect(dispatch).toEqual(PRODUCTION_DISPATCH);
  expect(completed).toEqual(PRODUCTION_COMPLETED);
  expect(sampleHashes).toEqual(PRODUCTION_SAMPLE_HASHES);
});

it('skips the dispatch queue scan entirely while no vehicle is idle', () => {
  const state = createAmhsState({
    loops: {
      1: { length: 100, stations: [station(1, 10, 0), station(1, 50, 1)] },
      2: { length: 100, stations: [station(2, 20, 0), station(2, 60, 1)] },
    },
    initialNextTaskTime: 1,
    vehicles: [{ loopId: 1, s: 0 }],
  });
  const random = createAmhsRandom(7).random;
  let observedBacklogWhileBusy = false;
  for (let tick = 0; tick < 6_000; tick += 1) {
    const queueLengthBefore = state.queue.length;
    const checksBefore = state.dispatchDistanceChecks;
    const scansBefore = state.dispatchScanPasses;
    const idleBefore = state.idleVehicleIds[1].size + state.idleVehicleIds[2].size;
    advanceAmhsState(state, 1 / 60, random);
    if (idleBefore !== 0) continue;
    // Every vehicle is busy: no dispatch scan may run, so no distance is evaluated
    // and no queued task may be assigned (the generator may append at most one new
    // task per frame before dispatch, so the queue never shrinks here).
    expect(state.dispatchDistanceChecks).toBe(checksBefore);
    expect(state.dispatchScanPasses).toBe(scansBefore);
    expect(state.queue.length).toBeGreaterThanOrEqual(queueLengthBefore);
    if (state.queue.length - queueLengthBefore > 1) throw new Error('unexpected queue growth');
    if (state.queue.length >= 3 && state.queue.some((task) => task.loopId === 1)) observedBacklogWhileBusy = true;
  }
  expect(observedBacklogWhileBusy).toBe(true);
});

it('keeps the exact shortest-distance tie-break and per-loop FIFO order', () => {
  const loops = {
    1: { length: 100, stations: [station(1, 10, 0), station(1, 50, 1)] },
    2: { length: 100, stations: [station(2, 20, 0), station(2, 60, 1)] },
  } as const;
  const state = createAmhsState({
    loops,
    // No generated tasks: inject the dispatch batch directly.
    initialNextTaskTime: 1e9,
    vehicles: [{ loopId: 1, s: 0 }, { loopId: 1, s: 0 }, { loopId: 2, s: 0 }],
  });
  const queued = (id: string, loopId: AmhsLoopId, pickup: number, index: number): AmhsTask => ({
    id, loopId, pickup: station(loopId, pickup, index), dropoff: station(loopId, pickup === 10 ? 50 : 10, 0),
    createdAt: 0, assignedAt: null, deliveredAt: null, state: 'QUEUED',
  });
  state.queue.push(
    queued('TSK-1', 1, 10, 0), queued('TSK-2', 2, 20, 0), queued('TSK-3', 1, 50, 1),
    queued('TSK-4', 2, 60, 1), queued('TSK-5', 1, 10, 0),
  );
  advanceAmhsState(state, 1 / 60, () => 0);
  // Two equal-distance loop-1 vehicles tie for TSK-1: source vehicle order wins (id 0).
  expect(state.vehicles[0].task?.id).toBe('TSK-1');
  // Lowest remaining loop-1 vehicle gets the next loop-1 queue head (TSK-3).
  expect(state.vehicles[1].task?.id).toBe('TSK-3');
  // Loop 2 is served after loop 1, FIFO within the loop: TSK-2 before TSK-4.
  expect(state.vehicles[2].task?.id).toBe('TSK-2');
  expect(state.queue.map((task) => task.id)).toEqual(['TSK-4', 'TSK-5']);
  // 2 (tie) + 1 loop-1 second assignment + 1 loop-2 = 4 distance evaluations.
  expect(state.dispatchDistanceChecks).toBe(4);
  expect(state.dispatchScanPasses).toBe(2);
  expect(state.idleVehicleIds[1].size).toBe(0);
  expect(state.idleVehicleIds[2].size).toBe(0);
  expect([...state.vehicles].map((vehicle) => vehicle.state)).toEqual(['TO_PICKUP', 'TO_PICKUP', 'TO_PICKUP']);
});

it('keeps cumulative completed counts without unbounded history, matching the frozen totals', () => {
  const randomA = createAmhsRandom(fixture.scenario.seed).random;
  const randomB = createAmhsRandom(fixture.scenario.seed).random;
  const production = createAmhsState({
    loops: fixture.scenario.loops,
    initialNextTaskTime: fixture.scenario.initialNextTaskTime,
    vehicles: fixture.scenario.vehicles,
  });
  const bounded = createAmhsState({
    loops: fixture.scenario.loops,
    initialNextTaskTime: fixture.scenario.initialNextTaskTime,
    vehicles: fixture.scenario.vehicles,
  }, { retainCompletedHistory: true, completedHistoryLimit: 3 });
  expect(production.completed).toEqual([]);
  expect(bounded.completed).toEqual([]);
  for (let tick = 1; tick <= fixture.scenario.ticks; tick += 1) {
    advanceAmhsState(production, fixture.scenario.dt, randomA);
    advanceAmhsState(bounded, fixture.scenario.dt, randomB);
    expect(production.completed).toHaveLength(0); // production keeps no task records
    expect(bounded.completed.length).toBeLessThanOrEqual(3); // opted-in retention is bounded
    expect(production.completedCount).toBe(bounded.completedCount);
  }
  expect(production.completedCount).toBe(fixture.stats.completed);
  expect(production.totalDeliveryTime).toBeCloseTo(fixture.stats.totalDeliveryTime, 6);
  expect(bounded.completed).toHaveLength(3);
  expect(bounded.completed[bounded.completed.length - 1].deliveredAt).toBeDefined();
});

it('re-enters a vehicle into the idle index after unloading so it can be dispatched again', () => {
  const state = createAmhsState(productionScenario());
  const random = createAmhsRandom(AMHS_TRAFFIC_SEED).random;
  let sawIdleReentry = false;
  for (let tick = 0; tick < 6_000 && !sawIdleReentry; tick += 1) {
    const unloading = state.vehicles.filter((vehicle) => vehicle.state === 'UNLOADING');
    advanceAmhsState(state, 1 / 60, random);
    if (unloading.length === 0) continue;
    // The vehicle that completed unloading this frame must be dispatchable next frame.
    for (const vehicle of unloading) {
      if (vehicle.state !== 'IDLE') continue;
      expect(state.idleVehicleIds[vehicle.loopId].has(vehicle.id)).toBe(true);
      sawIdleReentry = true;
    }
    const idle = state.vehicles.filter((vehicle) => vehicle.state === 'IDLE').length;
    expect(state.idleVehicleIds[1].size + state.idleVehicleIds[2].size).toBe(idle);
  }
  expect(sawIdleReentry).toBe(true);
  // LED contract unchanged for dispatched vehicles.
  const seen = new Set(state.vehicles.map((vehicle) => vehicle.ledHex));
  for (const led of seen) expect(Object.values(AMHS_LED_COLORS)).toContain(led);
});
