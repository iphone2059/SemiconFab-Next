import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { advanceAmhsState, createAmhsRandom, createAmhsState, AMHS_LED_COLORS, type AmhsState, type AmhsVehicle } from '../src/amhs-timeline';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/original-dynamics-vectors.json', import.meta.url), 'utf8'));

const round = (value: number, digits = 6): number => Math.round(value * 10 ** digits) / 10 ** digits + 0;

function phaseOf(vehicle: AmhsVehicle): string | null {
  if (vehicle.state !== 'LOADING' && vehicle.state !== 'UNLOADING') return null;
  if (vehicle.dwellTimer < 1.1) return 'hoist-down';
  if (vehicle.dwellTimer < 1.9) return 'handshake';
  if (vehicle.dwellTimer < 3.0) return 'hoist-up';
  return 'complete';
}

function vehicleView(vehicle: AmhsVehicle) {
  return {
    id: vehicle.id,
    loopId: vehicle.loopId,
    state: vehicle.state,
    taskId: vehicle.task ? vehicle.task.id : null,
    phase: phaseOf(vehicle),
    s: round(vehicle.s, 4),
    speed: round(vehicle.speed, 4),
    hoistY: round(vehicle.hoistY, 4),
    cableScaleY: round(vehicle.cableScaleY, 4),
    cableY: round(vehicle.cableY, 4),
    foup: vehicle.foupVisible ? 1 : 0,
    led: vehicle.ledHex,
  };
}

function simulate(): { state: AmhsState; events: Record<string, unknown>[]; snapshots: unknown[]; stats: unknown } {
  const stream = createAmhsRandom(fixture.scenario.seed);
  const state = createAmhsState({
    loops: fixture.scenario.loops,
    initialNextTaskTime: fixture.scenario.initialNextTaskTime,
    vehicles: fixture.scenario.vehicles,
  });
  const events: Record<string, unknown>[] = [];
  const snapshots: unknown[] = [];
  const seenTasks = new Set<string>();
  let previousCompleted = 0;
  let previous = new Map(state.vehicles.map(vehicle => [vehicle.id, vehicleView(vehicle)]));
  snapshots.push({ tick: 0, time: 0, vehicles: [...previous.values()] });

  const emit = (tick: number, type: string, fields: Record<string, unknown>) => {
    events.push({ tick, time: round(state.simTime), type, ...fields });
  };

  for (let tick = 1; tick <= fixture.scenario.ticks; tick += 1) {
    advanceAmhsState(state, fixture.scenario.dt, stream.random);
    const current = new Map(state.vehicles.map(vehicle => [vehicle.id, vehicleView(vehicle)]));
    for (const vehicle of state.vehicles) {
      const before = previous.get(vehicle.id)!;
      const after = current.get(vehicle.id)!;
      if (before.state !== after.state) emit(tick, 'vehicle-state', { vehicle: after.id, from: before.state, to: after.state, s: after.s, speed: after.speed });
      if (before.phase !== after.phase) emit(tick, 'load-phase', { vehicle: after.id, state: after.state, from: before.phase, to: after.phase, hoistY: after.hoistY, cableScaleY: after.cableScaleY, cableY: after.cableY, foup: after.foup });
      if (before.foup !== after.foup) emit(tick, 'foup', { vehicle: after.id, visible: after.foup === 1, hoistY: after.hoistY });
      if (before.led !== after.led) emit(tick, 'led', { vehicle: after.id, state: after.state, hex: after.led });
    }
    const tasks = [...state.queue, ...state.vehicles.map(vehicle => vehicle.task).filter((task): task is NonNullable<typeof task> => task !== null), ...state.completed];
    for (const task of tasks) {
      if (seenTasks.has(task.id)) continue;
      seenTasks.add(task.id);
      emit(tick, 'task-created', { task: task.id, loopId: task.loopId, pickup: task.pickup.id, dropoff: task.dropoff.id, createdAt: round(task.createdAt) });
      if (task.assignedAt !== null) emit(tick, 'task-assigned', { task: task.id, assignedAt: round(task.assignedAt) });
    }
    for (const vehicle of state.vehicles) {
      const before = previous.get(vehicle.id)!;
      const after = current.get(vehicle.id)!;
      if (after.taskId !== null && after.taskId !== before.taskId) emit(tick, 'dispatch', { task: after.taskId, vehicle: after.id, loopId: after.loopId, s: after.s });
    }
    for (const task of state.completed.slice(previousCompleted)) {
      emit(tick, 'task-completed', { task: task.id, deliveredAt: round(task.deliveredAt!), deliveryTime: round(task.deliveredAt! - task.createdAt) });
    }
    previousCompleted = state.completed.length;
    previous = current;
    if (tick % fixture.scenario.sampleEvery === 0) snapshots.push({ tick, time: round(state.simTime), vehicles: [...current.values()] });
  }

  const stats = {
    simTime: round(state.simTime),
    tasksGenerated: state.taskSeq,
    completed: state.completed.length,
    totalDeliveryTime: round(state.totalDeliveryTime),
    averageDeliveryTime: state.completed.length ? round(state.totalDeliveryTime / state.completed.length) : null,
    minObservedGap: Number.isFinite(state.minObservedGap) ? round(state.minObservedGap) : null,
    gapViolations: state.gapViolations,
    seedAfter: stream.seed(),
  };
  return { state, events, snapshots, stats };
}

it('reproduces the frozen-source AMHS traffic vectors for a declared scenario', () => {
  const { events, snapshots, stats } = simulate();
  expect(stats).toEqual(fixture.stats);
  expect(events).toEqual(fixture.events);
  expect(snapshots).toEqual(fixture.snapshots);
});

it('keeps the hard no-overtake spacing and idle-state LED contract', () => {
  const { state, events } = simulate();
  expect(state.gapViolations).toBe(0);
  expect(state.minObservedGap).toBeGreaterThanOrEqual(2.0);
  const ledHexes = events.filter(event => event.type === 'led').map(event => event.hex);
  expect(new Set(ledHexes)).toEqual(new Set([AMHS_LED_COLORS.TO_PICKUP, AMHS_LED_COLORS.LOADING, AMHS_LED_COLORS.TO_DROPOFF, AMHS_LED_COLORS.UNLOADING, AMHS_LED_COLORS.IDLE]));
  expect(state.completed.length).toBeGreaterThan(0);
  for (const task of state.completed) expect(task.deliveredAt! - task.createdAt).toBeGreaterThan(0);
});
