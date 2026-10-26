import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProcessTelemetry, createProcessMesJob, advanceProcessTelemetry, applyMesAction, computeSpc, type Telemetry, type ProcessEquipment, type MesAction } from '../src/process-control';
import { createDemoState, demoReducer } from '../src/twin-equipment';
import { computeFabYield, YIELD_SCENARIOS } from '../src/fab-yield';
import { generateWaferMap, stdfSummary, type DefectPattern, type WaferDie } from '../src/wafer-map';
import { initialTwinDemoState } from '../src/state/twinDemoStore';

type SourceTelemetry = Omit<Telemetry, 'sensors' | 'soh'> & {
  soh: string; sensors: { name: string; unit: string; val: number; min: number; max: number }[];
};
const fixture = JSON.parse(readFileSync(new URL('./fixtures/original-process-vectors.json', import.meta.url), 'utf8'));
function randomStream(seed: number) {
  let state = seed;
  return { random: () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }, seed: () => state };
}
const normalize = (value: SourceTelemetry): Telemetry => ({ ...value, soh: Number(value.soh), sensors: value.sensors.map(({ val, ...sensor }) => ({ ...sensor, value: val })) });

it('starts the actual demo store at the certified initialization without an extra scenario draw', () => {
  const state = initialTwinDemoState;
  expect(state.seed).toBe(fixture.trace[0].seed);
  expect(Object.keys(state.keys)).toEqual(Object.keys(fixture.trace[0].states));
});

it('matches frozen-source MES and all source telemetry categories with explicit random inputs', () => {
  for (const vector of fixture.initial as { equipment: ProcessEquipment; telemetry: SourceTelemetry; mes: unknown; seedAfter: number }[]) {
    const stream = randomStream(42);
    expect(createProcessTelemetry(vector.equipment, stream.random)).toEqual(normalize(vector.telemetry));
    expect(stream.seed()).toBe(vector.seedAfter);
    expect(createProcessMesJob(vector.equipment, 1000)).toEqual(vector.mes);
  }
});

it('preserves source MES action timestamps and wraps all 25 wafer slots', () => {
  let job = createProcessMesJob(fixture.mesEquipment, 1000);
  for (const vector of fixture.mesActions) {
    job = applyMesAction(job, vector.action as MesAction);
    expect(job).toEqual(vector.job);
  }
});

it('matches source etch/overlay/CMP/furnace phase branches, DOWN scaling and 25-sample trimming', () => {
  const stream = randomStream(42);
  const equipment = fixture.recipeEquipment as ProcessEquipment[];
  let telemetry = Object.fromEntries(equipment.map(eq => [eq.id, createProcessTelemetry(eq, stream.random)]));
  for (const vector of fixture.recipeTrace) {
    telemetry = Object.fromEntries(equipment.map(eq => [eq.id, advanceProcessTelemetry(telemetry[eq.id], eq, vector.cycle, true, stream.random)]));
    for (const eq of equipment) expect(telemetry[eq.id]).toEqual(normalize(vector.telemetry[eq.id]));
    expect(stream.seed()).toBe(vector.seed);
  }
});

it('matches 29 source ticks: telemetry then Andon, then eight yield jitter inputs', () => {
  let state = createDemoState(42);
  for (const vector of fixture.trace) {
    expect(state.cycle).toBe(vector.cycle);
    expect(state.seed).toBe(vector.seed);
    expect(state.keys).toEqual(Object.fromEntries(Object.entries(vector.states).map(([id, value]) => [id, (value as string).toLowerCase()])));
    for (const [id, telemetry] of Object.entries(vector.telemetry)) expect(state.telemetry[id]).toEqual(normalize(telemetry as SourceTelemetry));
    const result = computeFabYield(state.states, YIELD_SCENARIOS[0], { directoryStates: state.referenceLights, scenarioId: 'baseline', jitter: state.yieldJitter });
    expect(result.totalYield).toBe(vector.yield.totalYield);
    expect(result.wpm).toBe(vector.yield.wpm);
    expect(result.bottleneck.id).toBe(vector.yield.bottleneck.id);
    for (const module of result.modules) expect(module.stepYield).toBe(vector.yield.moduleYields[module.module.id]);
    state = demoReducer(state, { type: 'tick' });
  }
});

it('matches source SPC displays for insufficient/constant/trend/shift/outlier and DOWN vectors', () => {
  for (const vector of fixture.spc) {
    const result = computeSpc(vector.history, { ...vector.sensor, value: vector.sensor.val }, vector.down);
    expect(result.cp.toFixed(2)).toBe(vector.display['spc-cp-val']);
    expect(result.cpk.toFixed(2)).toBe(vector.display['spc-cpk-val']);
    expect(`${result.sigma.toFixed(2)} σ`).toBe(vector.display['spc-sigma-level']);
    expect(result.status).toBe(vector.display['spc-status-badge']);
    expect(result.rule).toBe(vector.display['spc-nelson-rule']);
  }
});

it('matches all six original Scenario yields, bottlenecks and WPM with explicit jitter', () => {
  const directoryStates = Object.fromEntries(Object.keys(fixture.trace[0].states).map(id => [id, 'down' as const]));
  for (const vector of fixture.scenarios) {
    const scenario = YIELD_SCENARIOS.find(value => value.id === vector.scenario.id)!;
    expect(scenario).toEqual(vector.scenario);
    const stream = randomStream(42);
    const jitter = Array.from({ length: 8 }, () => (stream.random() - 0.5) * 0.003);
    const result = computeFabYield([], scenario, { scenarioId: scenario.id, directoryStates, jitter });
    expect(result.totalYield).toBe(vector.yield.totalYield);
    expect(result.wpm).toBe(vector.yield.wpm);
    expect(result.bottleneck.id).toBe(vector.yield.bottleneck.id);
  }
});

it('matches every source die/bin and exported STDF field for all seven spatial patterns', () => {
  for (const vector of fixture.wafer as { pattern: DefectPattern; seed: number; dies: WaferDie[]; stdf: unknown; seedAfter: number }[]) {
    const stream = randomStream(vector.seed);
    const dies = generateWaferMap(vector.pattern, stream.random);
    expect(dies).toEqual(vector.dies);
    expect(stdfSummary(dies, vector.pattern)).toEqual(vector.stdf);
    expect(stream.seed()).toBe(vector.seedAfter);
  }
});
