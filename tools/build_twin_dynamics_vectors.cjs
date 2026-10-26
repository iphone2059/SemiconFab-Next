// Test-only execution of frozen original timing functions; no original runtime ships.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.resolve(root, '../SemiconFab/twin.html'), 'utf8');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== manifest.source_sha256['twin.html']) throw new Error('Original source drift');

const extractFunction = (name) => {
  const start = source.indexOf('      function ' + name + '(');
  const closing = '\n      }';
  const end = source.indexOf(closing, start);
  if (start < 0 || end < 0) throw new Error('Missing source function ' + name);
  return source.slice(start, end + closing.length);
};
const extractConst = (name, opening, closing) => {
  const start = source.indexOf('      const ' + name + ' = ' + opening);
  const end = source.indexOf('\n      ' + closing, start);
  if (start < 0 || end < 0) throw new Error('Missing source const ' + name);
  return source.slice(start, end + ('\n      ' + closing).length);
};

const declarations = [
  extractConst('AMHS_STATIONS_LOOP1', '[', '];'),
  extractConst('AMHS_STATIONS_LOOP2', '[', '];'),
  extractConst('AMHS_LED_COLORS', '{', '};'),
  extractFunction('setVehicleLedColor'),
  extractFunction('updateAmhsSimulation'),
].join('\n');

const scenario = {
  seed: 42,
  dt: 1 / 60,
  ticks: 7200,
  sampleEvery: 60,
  loopLengths: { 1: 265.33, 2: 196.07 },
  initialNextTaskTime: 1.0,
};
scenario.vehicles = [
  ...Array.from({ length: 12 }, (_, index) => ({ loopId: 1, s: (index / 12) * scenario.loopLengths[1] })),
  ...Array.from({ length: 12 }, (_, index) => ({ loopId: 2, s: (index / 12) * scenario.loopLengths[2] })),
];

const round = (value, digits = 6) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits + 0 : null;

function createLedStub() {
  const slot = { hex: 0x10b981 };
  return {
    material: {
      color: { setHex(value) { slot.hex = value; return this; } },
      emissive: { setHex(value) { slot.hex = value; return this; } },
      get hex() { return slot.hex; },
    },
    get hex() { return slot.hex; },
  };
}

function createVehicle(entry, index) {
  const vehicle = {
    id: index,
    name: 'OHT-' + (index + 1),
    loopId: entry.loopId,
    s: entry.s,
    speed: 1.4,
    state: 'IDLE',
    task: null,
    targetStation: null,
    dwellTimer: 0,
    hoistGroup: { position: { y: 0 } },
    cables: [{ scale: { y: 0.5 }, position: { y: 5.55 } }, { scale: { y: 0.5 }, position: { y: 5.55 } }],
    foupMesh: { visible: false },
    lightBar: createLedStub(),
    group: null,
    curve: null,
  };
  vehicle.lightBar.material.color.setHex(0x10b981);
  return vehicle;
}

function phaseOf(vehicle) {
  if (vehicle.state !== 'LOADING' && vehicle.state !== 'UNLOADING') return null;
  const timer = vehicle.dwellTimer;
  if (timer < 1.1) return 'hoist-down';
  if (timer < 1.9) return 'handshake';
  if (timer < 3.0) return 'hoist-up';
  return 'complete';
}

function vehicleView(vehicle) {
  return {
    id: vehicle.id,
    loopId: vehicle.loopId,
    state: vehicle.state,
    taskId: vehicle.task ? vehicle.task.id : null,
    phase: phaseOf(vehicle),
    s: round(vehicle.s, 4),
    speed: round(vehicle.speed, 4),
    hoistY: round(vehicle.hoistGroup.position.y, 4),
    cableScaleY: round(vehicle.cables[0].scale.y, 4),
    cableY: round(vehicle.cables[0].position.y, 4),
    foup: vehicle.foupMesh.visible ? 1 : 0,
    led: vehicle.lightBar.material.hex,
  };
}

function simulate() {
  let randomState = scenario.seed >>> 0;
  const math = Object.create(Math);
  math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 2 ** 32;
  };
  const vehicles = scenario.vehicles.map(createVehicle);
  const context = {
    Math: math,
    document: { getElementById: () => null },
    window: {},
    console,
    showOht: false,
    ohtVehicles: vehicles,
    amhsLoopLength1: scenario.loopLengths[1],
    amhsLoopLength2: scenario.loopLengths[2],
    amhsTaskQueue: [],
    amhsCompletedTasks: [],
    amhsTaskSeq: 0,
    amhsNextTaskTime: scenario.initialNextTaskTime,
    amhsSimTime: 0,
    amhsTotalDeliveryTime: 0,
    amhsMinObservedGap: Infinity,
    amhsGapViolations: 0,
    amhsLastHudUpdate: 0,
    amhsLastFrameTime: 0,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(declarations + '\n' +
    'function __step(dt) { updateAmhsSimulation(dt); }\n' +
    'globalThis.__source = { loop1: AMHS_STATIONS_LOOP1, loop2: AMHS_STATIONS_LOOP2, led: AMHS_LED_COLORS };', context);

  const events = [];
  const snapshots = [];
  const seenTasks = new Set();
  let previous = new Map(vehicles.map(vehicle => [vehicle.id, vehicleView(vehicle)]));

  const emit = (tick, type, fields) => {
    events.push({ tick, time: round(context.amhsSimTime), type, ...fields });
  };
  const observe = (tick) => {
    const current = new Map(vehicles.map(vehicle => [vehicle.id, vehicleView(vehicle)]));
    for (const vehicle of vehicles) {
      const before = previous.get(vehicle.id);
      const after = current.get(vehicle.id);
      if (before.state !== after.state) {
        emit(tick, 'vehicle-state', { vehicle: after.id, from: before.state, to: after.state, s: after.s, speed: after.speed });
      }
      if (before.phase !== after.phase) {
        emit(tick, 'load-phase', {
          vehicle: after.id, state: after.state, from: before.phase, to: after.phase,
          hoistY: after.hoistY, cableScaleY: after.cableScaleY, cableY: after.cableY, foup: after.foup,
        });
      }
      if (before.foup !== after.foup) emit(tick, 'foup', { vehicle: after.id, visible: after.foup === 1, hoistY: after.hoistY });
      if (before.led !== after.led) emit(tick, 'led', { vehicle: after.id, state: after.state, hex: after.led });
    }
    const tasks = [
      ...context.amhsTaskQueue,
      ...vehicles.map(vehicle => vehicle.task).filter(Boolean),
      ...context.amhsCompletedTasks,
    ];
    for (const task of tasks) {
      if (seenTasks.has(task.id)) continue;
      seenTasks.add(task.id);
      emit(tick, 'task-created', {
        task: task.id, loopId: task.loopId, pickup: task.pickup.id, dropoff: task.dropoff.id, createdAt: round(task.createdAt),
      });
      if (task.assignedAt !== null) emit(tick, 'task-assigned', { task: task.id, assignedAt: round(task.assignedAt) });
    }
    for (const vehicle of vehicles) {
      const before = previous.get(vehicle.id);
      const after = current.get(vehicle.id);
      if (after.taskId !== null && after.taskId !== before.taskId) {
        emit(tick, 'dispatch', { task: after.taskId, vehicle: after.id, loopId: after.loopId, s: after.s });
      }
    }
    const beforeCompleted = previousCompleted;
    for (const task of context.amhsCompletedTasks.slice(beforeCompleted)) {
      emit(tick, 'task-completed', {
        task: task.id, deliveredAt: round(task.deliveredAt),
        deliveryTime: round(task.deliveredAt - task.createdAt),
      });
    }
    previousCompleted = context.amhsCompletedTasks.length;
    previous = current;
    if (tick % scenario.sampleEvery === 0) {
      snapshots.push({ tick, time: round(context.amhsSimTime), vehicles: [...current.values()] });
    }
  };
  let previousCompleted = 0;
  snapshots.push({ tick: 0, time: 0, vehicles: [...previous.values()] });

  for (let tick = 1; tick <= scenario.ticks; tick += 1) {
    context.__step(scenario.dt);
    observe(tick);
  }

  const completed = context.amhsCompletedTasks;
  return {
    sourceSha256: hash,
    sourceFunctions: {
      updateAmhsSimulation: [18696, 19045],
      setVehicleLedColor: [15372, 15377],
      AMHS_STATIONS_LOOP1: [15219, 15276],
      AMHS_STATIONS_LOOP2: [15278, 15335],
      AMHS_LED_COLORS: [15337, 15343],
    },
    scenario: {
      seed: scenario.seed,
      dt: scenario.dt,
      ticks: scenario.ticks,
      sampleEvery: scenario.sampleEvery,
      loops: {
        1: { length: scenario.loopLengths[1], stations: context.__source.loop1 },
        2: { length: scenario.loopLengths[2], stations: context.__source.loop2 },
      },
      led: context.__source.led,
      initialNextTaskTime: scenario.initialNextTaskTime,
      vehicles: scenario.vehicles,
    },
    events,
    snapshots,
    stats: {
      simTime: round(context.amhsSimTime),
      tasksGenerated: context.amhsTaskSeq,
      completed: completed.length,
      totalDeliveryTime: round(context.amhsTotalDeliveryTime),
      averageDeliveryTime: completed.length ? round(context.amhsTotalDeliveryTime / completed.length) : null,
      minObservedGap: round(context.amhsMinObservedGap),
      gapViolations: context.amhsGapViolations,
      seedAfter: randomState,
    },
  };
}

const result = simulate();
const json = JSON.stringify(result) + '\n';
const destination = path.join(root, 'web_app/tests/fixtures/original-dynamics-vectors.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== json) throw new Error('Dynamics vectors drift');
  console.log('Dynamics vectors stable: ' + result.events.length + ' events, ' + result.snapshots.length + ' snapshots');
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json);
  console.log('Original dynamics vectors: ' + result.events.length + ' events, ' + result.snapshots.length + ' snapshots, ' +
    result.stats.tasksGenerated + ' tasks, seedAfter ' + result.stats.seedAfter);
}
