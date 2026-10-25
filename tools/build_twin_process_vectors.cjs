// Test-only execution of frozen original functions; no original runtime ships.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.resolve(root, '../SemiconFab/twin.html'), 'utf8');
const manifest = require('../docs/migration/twin-parity/source-manifest.json');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== manifest.source_sha256['twin.html']) throw new Error('Original source drift');
const ui = require('../web_app/assets/original-twin-ui.json');
function extract(name, declaration = 'function') {
  const start = source.indexOf(`      ${declaration} ${name}`);
  const closing = declaration === 'function' ? '\n      }' : name === 'DT_SCENARIOS' ? '\n      };' : '\n      ];';
  const end = source.indexOf(closing, start);
  if (start < 0 || end < 0) throw new Error(`Missing source ${name}`);
  return source.slice(start, end + closing.length);
}
const functions = ['generateInitialTelemetry', 'simulationTick', 'getOrInitMesJob', 'updateInspectorMesJob', 'mesTrackInCurrent', 'mesTrackOutCurrent', 'mesHoldLotCurrent', 'updateInspectorSpc', 'calculateFabYieldAndCapa', 'renderWaferMapSvg', 'copyStdfJson'];
function reference(seed = 42) {
  let state = seed >>> 0;
  const elements = {};
  const math = Object.create(Math);
  math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const context = vm.createContext({ Math: math, Date: { now: () => 1000 }, elements,
    document: { getElementById: id => elements[id] ?? null },
    navigator: { clipboard: { writeText: text => { context.stdf = JSON.parse(text); return Promise.resolve(); } } },
    FAB_EQUIPMENT: structuredClone(ui.equipment), equipmentStateMap: {}, equipmentTelemetryMap: {}, equipmentMesStateMap: {},
    equipmentSignalLightsMap: new Map(ui.signalKeys.map(key => [key, {}])),
    currentEntryMode: 'engineer', currentScenarioId: 'baseline', simCycle: 1,
    DT_SCENARIOS: { baseline: { id: 'baseline', purity: 5.5, health: 96.8, lagTime: 0.8 } },
    updateEquipmentSignalLight() {}, updateInspectorTelemetry() {}, renderYieldWaterfall() {},
    updateWaferAnalytics() {}, selectedEquipmentId: null, activeWaferDies: [], currentWaferPattern: 'clean',
  });
  vm.runInContext(extract('CORE_PROCESS_MODULES', 'const') + '\n' + extract('DT_SCENARIOS', 'const') + '\n' + functions.map(name => extract(name)).join('\n'), context);
  const run = code => vm.runInContext(code, context);
  const json = code => JSON.parse(JSON.stringify(run(code)));
  return { context, run, json, seed: () => state };
}
const categories = ['subfab', 'litho', 'etch', 'depo', 'imp_therm', 'wet_cmp', 'metro', 'amhs', 'facility', 'pkg'];
const equipment = categories.map((category, index) => ({ id: `vector.${category}.${index}`, category, name: `Vector ${category}`, position: { x: index - 4.5 } }));
equipment.push(...['laser', 'pump', 'scrubber', 'upw'].map(kind => ({ id: `subfab.${kind}.1`, category: 'subfab', name: kind, position: { x: 0 } })));
equipment.push({ id: 'fe.furnace.1', category: 'imp_therm', name: 'Furnace', position: { x: 1 } });
const initial = equipment.map(eq => { const ref = reference(42); ref.context.eq = eq; return { equipment: eq, telemetry: ref.json('generateInitialTelemetry(eq)'), mes: ref.json('getOrInitMesJob(eq)'), seedAfter: ref.seed() }; });
const mesRef = reference();
mesRef.context.selectedEquipmentId = ui.equipment[0].id;
const mesActions = ['track-out', 'hold', 'track-in', ...Array(25).fill('track-out')].map(action => {
  mesRef.run(({ 'track-out': 'mesTrackOutCurrent()', hold: 'mesHoldLotCurrent()', 'track-in': 'mesTrackInCurrent()' })[action]);
  return { action, job: mesRef.json('equipmentMesStateMap[selectedEquipmentId]') };
});
const recipeRef = reference();
recipeRef.context.FAB_EQUIPMENT = equipment;
recipeRef.context.equipmentSignalLightsMap = new Map();
recipeRef.run('calculateFabYieldAndCapa = () => {}; FAB_EQUIPMENT.forEach(eq => { equipmentStateMap[eq.id] = "DOWN"; equipmentTelemetryMap[eq.id] = generateInitialTelemetry(eq); });');
const recipeTrace = [];
for (let tick = 0; tick < 26; tick++) {
  recipeRef.run('simulationTick()');
  recipeTrace.push({ cycle: recipeRef.context.simCycle, seed: recipeRef.seed(), telemetry: recipeRef.json('equipmentTelemetryMap') });
}
const traceRef = reference(42);
traceRef.run('FAB_EQUIPMENT.forEach(eq => { equipmentStateMap[eq.id] = "RUNNING"; equipmentTelemetryMap[eq.id] = generateInitialTelemetry(eq); }); calculateFabYieldAndCapa();');
const trace = [];
const snapshot = () => ({ cycle: traceRef.context.simCycle, seed: traceRef.seed(), telemetry: traceRef.json('equipmentTelemetryMap'), states: traceRef.json('equipmentStateMap'), yield: traceRef.json('currentYieldMetrics') });
trace.push(snapshot());
for (let tick = 0; tick < 28; tick++) { traceRef.run('simulationTick()'); trace.push(snapshot()); }
const sensor = { name: 'Vector', val: 10, unit: 'u', min: 0, max: 20 };
const histories = [[], [10, 10, 10, 10], [10, 10, 10, 10, 10], [1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], [0, ...Array(9).fill(10)], [...Array(24).fill(10), 100]];
const spc = histories.flatMap(history => [false, true].map(down => {
  const ref = reference();
  for (const id of ['spc-cp-val', 'spc-cpk-val', 'spc-sigma-level', 'spc-status-badge', 'spc-nelson-rule']) ref.context.elements[id] = { textContent: id === 'spc-status-badge' ? 'IN CONTROL' : id === 'spc-nelson-rule' ? 'PASS: Nelson 8 Rules In-Spec' : '' };
  ref.context.telem = { history, sensors: [sensor] };
  ref.context.equipmentStateMap.vector = down ? 'DOWN' : 'RUNNING';
  ref.run('updateInspectorSpc({id:"vector"}, telem)');
  return { history, down, sensor, display: Object.fromEntries(Object.entries(ref.context.elements).map(([id, el]) => [id, el.textContent])) };
}));
const wafer = ['clean', 'center', 'ring', 'scratch', 'donut', 'random', 'edge_local'].map(pattern => {
  const ref = reference(811);
  ref.context.elements['wafer-svg-container'] = {};
  ref.context.currentWaferPattern = pattern;
  ref.run('renderWaferMapSvg(); copyStdfJson()');
  return { pattern, seed: 811, dies: ref.json('activeWaferDies'), stdf: ref.context.stdf, seedAfter: ref.seed() };
});
const scenarios = reference().json('Object.values(DT_SCENARIOS)').map(scenario => {
  const ref = reference(42);
  ref.context.currentScenarioId = scenario.id;
  ref.run('FAB_EQUIPMENT.forEach(eq=>{equipmentStateMap[eq.id]="DOWN"}); calculateFabYieldAndCapa()');
  return { scenario, yield: ref.json('currentYieldMetrics') };
});
const result = JSON.stringify({ sourceSha256: hash, initial, mesEquipment: ui.equipment[0], mesActions, recipeEquipment: equipment, recipeTrace, trace, spc, wafer, scenarios }) + '\n';
const destination = path.join(root, 'web_app/tests/fixtures/original-process-vectors.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== result) throw new Error('Process vectors drift');
} else fs.writeFileSync(destination, result);
console.log(`Original process vectors: ${initial.length} initial, ${trace.length} directory ticks, ${recipeTrace.length} recipe ticks, ${mesActions.length} MES actions, ${spc.length} SPC, ${scenarios.length} Scenarios, ${wafer.length} wafer/STDF cases`);
