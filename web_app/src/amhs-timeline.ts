// Literal port of the frozen original AMHS closed-loop traffic simulation
// (twin.html b3666132, updateAmhsSimulation 18688-19037). Pure timing/state only:
// the renderer maps these values onto meshes. No DOM, Math.random, timers or THREE.

export type AmhsVehicleState = 'IDLE' | 'TO_PICKUP' | 'LOADING' | 'TO_DROPOFF' | 'UNLOADING';
export type AmhsTaskState = 'QUEUED' | 'ASSIGNED' | 'COMPLETED';
export type AmhsLoopId = 1 | 2;

export interface AmhsStation {
  id: string;
  loopId: AmhsLoopId;
  s: number;
  bay: string;
  bayName: string;
  bayNameZh: string;
}

export interface AmhsTask {
  id: string;
  loopId: AmhsLoopId;
  pickup: AmhsStation;
  dropoff: AmhsStation;
  createdAt: number;
  assignedAt: number | null;
  deliveredAt: number | null;
  state: AmhsTaskState;
}

/** Declared seed for the product-side task stream; original page used unseeded Math.random. */
export const AMHS_TRAFFIC_SEED = 42;

/** Declared deterministic replacement for the frozen page's Math.random (same LCG as the fixtures). */
export function createAmhsRandom(seed: number): { random: () => number; seed: () => number } {
  let state = seed >>> 0;
  return {
    random: () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    },
    seed: () => state,
  };
}

export const AMHS_LED_COLORS = {
  IDLE: 0x10b981,
  TO_PICKUP: 0x38bdf8,
  LOADING: 0xf59e0b,
  TO_DROPOFF: 0x38bdf8,
  UNLOADING: 0xf59e0b,
} as const;

export interface AmhsVehicle {
  id: number;
  name: string;
  loopId: AmhsLoopId;
  /** Arc-length coordinate on the loop (m). */
  s: number;
  speed: number;
  state: AmhsVehicleState;
  task: AmhsTask | null;
  targetStation: AmhsStation | null;
  dwellTimer: number;
  hoistY: number;
  cableScaleY: number;
  cableY: number;
  foupVisible: boolean;
  ledHex: number;
}

export interface AmhsLoop {
  length: number;
  stations: readonly AmhsStation[];
}

export interface AmhsScenario {
  loops: Record<AmhsLoopId, AmhsLoop>;
  initialNextTaskTime: number;
  vehicles: readonly { loopId: AmhsLoopId; s: number }[];
}

export interface AmhsState {
  loops: Record<AmhsLoopId, AmhsLoop>;
  simTime: number;
  nextTaskTime: number;
  taskSeq: number;
  totalDeliveryTime: number;
  minObservedGap: number;
  gapViolations: number;
  lastHudUpdate: number;
  queue: AmhsTask[];
  completed: AmhsTask[];
  vehicles: AmhsVehicle[];
}

export function createAmhsState(scenario: AmhsScenario): AmhsState {
  const vehicles: AmhsVehicle[] = scenario.vehicles.map((entry, index) => ({
    id: index,
    name: `OHT-${index + 1}`,
    loopId: entry.loopId,
    s: entry.s,
    speed: 1.4,
    state: 'IDLE',
    task: null,
    targetStation: null,
    dwellTimer: 0,
    hoistY: 0,
    cableScaleY: 0.5,
    cableY: 5.55,
    foupVisible: false,
    ledHex: AMHS_LED_COLORS.IDLE,
  }));
  return {
    loops: scenario.loops,
    simTime: 0,
    nextTaskTime: scenario.initialNextTaskTime,
    taskSeq: 0,
    totalDeliveryTime: 0,
    minObservedGap: Infinity,
    gapViolations: 0,
    lastHudUpdate: 0,
    queue: [],
    completed: [],
    vehicles,
  };
}

/** Advances exactly one source frame. `random` stands in for the frozen page's Math.random. */
export function advanceAmhsState(state: AmhsState, dt: number, random: () => number): void {
  const clampedDt = Math.min(0.1, Math.max(0.001, dt));
  state.simTime += clampedDt;

  // 1. Poisson task generator (mean interval ~4 s).
  if (state.simTime >= state.nextTaskTime) {
    const loopId: AmhsLoopId = random() < 0.5 ? 1 : 2;
    const stations = state.loops[loopId].stations;
    const pIdx = Math.floor(random() * stations.length);
    let dIdx = Math.floor(random() * stations.length);
    while (dIdx === pIdx) dIdx = Math.floor(random() * stations.length);
    const task: AmhsTask = {
      id: `TSK-${++state.taskSeq}`,
      loopId,
      pickup: stations[pIdx],
      dropoff: stations[dIdx],
      createdAt: state.simTime,
      assignedAt: null,
      deliveredAt: null,
      state: 'QUEUED',
    };
    state.queue.push(task);
    const interval = -Math.log(1 - random() * 0.98) * 4.0;
    state.nextTaskTime = state.simTime + Math.max(1.2, interval);
  }

  // 2. FIFO queue with nearest-idle-vehicle dispatch per loop.
  for (const loopId of [1, 2] as const) {
    const L = state.loops[loopId].length;
    for (let qi = 0; qi < state.queue.length; qi += 1) {
      const task = state.queue[qi];
      if (task.loopId !== loopId) continue;
      let bestVehicle: AmhsVehicle | null = null;
      let minDistance = Infinity;
      for (const vehicle of state.vehicles) {
        if (vehicle.loopId === loopId && vehicle.state === 'IDLE') {
          const distance = (task.pickup.s - vehicle.s + L) % L;
          if (distance < minDistance) {
            minDistance = distance;
            bestVehicle = vehicle;
          }
        }
      }
      if (bestVehicle) {
        bestVehicle.state = 'TO_PICKUP';
        bestVehicle.task = task;
        bestVehicle.targetStation = task.pickup;
        task.assignedAt = state.simTime;
        task.state = 'ASSIGNED';
        bestVehicle.ledHex = AMHS_LED_COLORS.TO_PICKUP;
        state.queue.splice(qi, 1);
        qi -= 1;
      }
    }
  }

  // 3. Vehicle kinematics, hard no-overtake spacing and load/unload cycles.
  const aAccel = 1.5;
  const aDecel = 1.5;
  const aHardBrake = 4.0;
  const vmax = 3.0;

  for (const loopId of [1, 2] as const) {
    const L = state.loops[loopId].length;
    const loopVehicles = state.vehicles.filter((vehicle) => vehicle.loopId === loopId);
    for (let i = 0; i < loopVehicles.length; i += 1) {
      const vehicle = loopVehicles[i];
      let minGap = Infinity;
      let leadVehicle: AmhsVehicle | null = null;
      let rearVehicle: AmhsVehicle | null = null;
      let minRearGap = Infinity;
      for (let j = 0; j < loopVehicles.length; j += 1) {
        if (i === j) continue;
        const gap = (loopVehicles[j].s - vehicle.s + L) % L;
        if (gap < minGap) {
          minGap = gap;
          leadVehicle = loopVehicles[j];
        }
        const rearGap = (vehicle.s - loopVehicles[j].s + L) % L;
        if (rearGap < minRearGap) {
          minRearGap = rearGap;
          rearVehicle = loopVehicles[j];
        }
      }
      if (minGap < state.minObservedGap) state.minObservedGap = minGap;
      if (minGap < 2.0) state.gapViolations += 1;

      if (vehicle.state === 'LOADING') {
        vehicle.speed = 0;
        vehicle.dwellTimer += clampedDt;
        const t = vehicle.dwellTimer;
        if (t < 1.1) {
          const p = t / 1.1;
          const ease = 0.5 - Math.cos(p * Math.PI) / 2;
          setHoist(vehicle, 3.2 * ease);
        } else if (t < 1.9) {
          vehicle.hoistY = -3.2;
          vehicle.cableScaleY = 3.7;
          vehicle.cableY = 3.95;
          if (t >= 1.5) vehicle.foupVisible = true;
        } else if (t < 3.0) {
          const p = (t - 1.9) / 1.1;
          const ease = 0.5 - Math.cos(p * Math.PI) / 2;
          setHoist(vehicle, 3.2 * (1 - ease));
        } else {
          vehicle.hoistY = 0;
          vehicle.cableScaleY = 0.5;
          vehicle.cableY = 5.55;
          vehicle.state = 'TO_DROPOFF';
          vehicle.targetStation = vehicle.task!.dropoff;
          vehicle.dwellTimer = 0;
          vehicle.ledHex = AMHS_LED_COLORS.TO_DROPOFF;
        }
        continue;
      }

      if (vehicle.state === 'UNLOADING') {
        vehicle.speed = 0;
        vehicle.dwellTimer += clampedDt;
        const t = vehicle.dwellTimer;
        if (t < 1.1) {
          const p = t / 1.1;
          const ease = 0.5 - Math.cos(p * Math.PI) / 2;
          setHoist(vehicle, 3.2 * ease);
        } else if (t < 1.9) {
          vehicle.hoistY = -3.2;
          vehicle.cableScaleY = 3.7;
          vehicle.cableY = 3.95;
          if (t >= 1.5) vehicle.foupVisible = false;
        } else if (t < 3.0) {
          const p = (t - 1.9) / 1.1;
          const ease = 0.5 - Math.cos(p * Math.PI) / 2;
          setHoist(vehicle, 3.2 * (1 - ease));
        } else {
          vehicle.hoistY = 0;
          vehicle.cableScaleY = 0.5;
          vehicle.cableY = 5.55;
          const task = vehicle.task!;
          task.deliveredAt = state.simTime;
          task.state = 'COMPLETED';
          state.completed.push(task);
          state.totalDeliveryTime += task.deliveredAt - task.createdAt;
          vehicle.task = null;
          vehicle.targetStation = null;
          vehicle.state = 'IDLE';
          vehicle.dwellTimer = 0;
          vehicle.ledHex = AMHS_LED_COLORS.IDLE;
        }
        continue;
      }

      let kinematic = 1.4;
      if (vehicle.state === 'IDLE' && rearVehicle && rearVehicle.state !== 'IDLE' && minRearGap < 12.0) {
        kinematic = vmax;
      }
      if (vehicle.targetStation) {
        const distanceToStation = (vehicle.targetStation.s - vehicle.s + L) % L;
        const CREEP_DIST = 1.2;
        const vCreep = 0.22;
        const stationLimit = distanceToStation <= CREEP_DIST
          ? vCreep
          : Math.sqrt(vCreep * vCreep + 2 * aDecel * (distanceToStation - CREEP_DIST));
        if (
          (distanceToStation <= 0.25 && vehicle.speed < 0.32) ||
          distanceToStation <= Math.max(0.06, vehicle.speed * clampedDt)
        ) {
          vehicle.s = vehicle.targetStation.s;
          vehicle.speed = 0;
          if (vehicle.state === 'TO_PICKUP') {
            vehicle.state = 'LOADING';
            vehicle.dwellTimer = 0;
            vehicle.ledHex = AMHS_LED_COLORS.LOADING;
          } else if (vehicle.state === 'TO_DROPOFF') {
            vehicle.state = 'UNLOADING';
            vehicle.dwellTimer = 0;
            vehicle.ledHex = AMHS_LED_COLORS.UNLOADING;
          }
          continue;
        }
        kinematic = Math.min(vmax, stationLimit);
      }

      const MIN_SAFETY_GAP = 2.08;
      let followLimit = vmax;
      if (minGap <= MIN_SAFETY_GAP) {
        followLimit = 0;
      } else if (minGap < 4.0) {
        const brakeCurve = Math.sqrt(2 * aDecel * (minGap - MIN_SAFETY_GAP));
        const ratio = vmax * ((minGap - MIN_SAFETY_GAP) / (4.0 - MIN_SAFETY_GAP));
        const leadSpeed = leadVehicle ? Math.max(0, leadVehicle.speed) : 0;
        followLimit = Math.min(ratio, brakeCurve, leadSpeed);
      }

      const desired = Math.min(kinematic, followLimit);
      if (vehicle.speed < desired) {
        vehicle.speed = Math.min(desired, vehicle.speed + aAccel * clampedDt);
      } else if (vehicle.speed > desired) {
        const brakeRate = minGap < 2.5 ? aHardBrake : aDecel;
        vehicle.speed = Math.max(0, Math.max(desired, vehicle.speed - brakeRate * clampedDt));
      }

      const maxAdvance = Math.max(0, minGap - 2.02);
      const step = Math.min(vehicle.speed * clampedDt, maxAdvance);
      if (step < vehicle.speed * clampedDt && vehicle.speed > 0) {
        vehicle.speed = step / clampedDt;
      }
      vehicle.s = (vehicle.s + step) % L;
    }
  }

  // 4. Source HUD throttle bookkeeping (rendering layer owns the texts).
  if (state.simTime - state.lastHudUpdate > 0.2) state.lastHudUpdate = state.simTime;
}

function setHoist(vehicle: AmhsVehicle, dropDistance: number): void {
  vehicle.hoistY = -dropDistance;
  const cableLength = Math.max(0.5, dropDistance + 0.5);
  vehicle.cableScaleY = cableLength;
  vehicle.cableY = 5.8 - cableLength / 2;
}
