import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '../fab/fab-layout';
import type { ResearchSnapshot } from './research-replay';
import { TWIN_LAYOUT_IDENTITIES } from '../fab/layout-identities';
import { buildOriginalSignalRegistry, ORIGINAL_TWIN_UI } from '../fab/original-twin-data';
import { createProcessTelemetry, advanceProcessTelemetry, type Telemetry } from '../fab/process-control';
export { buildLayoutIdentities, TWIN_LAYOUT_IDENTITIES, type LayoutIdentity } from '../fab/layout-identities';

export interface ScenarioOverrides { overrides: Readonly<Record<string, 'RUNNING' | 'IDLE' | 'DOWN' | 'MAINT'>> }

export function resolveScenario(scenario: ScenarioOverrides) {
  const matched = new Set<string>();
  const states = TWIN_LAYOUT_IDENTITIES.map((identity): FabToolState => {
    const id = Object.hasOwn(scenario.overrides, identity.instanceId) ? identity.instanceId : identity.recordId;
    const override = scenario.overrides[id];
    if (!override) return 'running';
    matched.add(id);
    return override.toLowerCase() as FabToolState;
  });
  return { states, unresolvedIds: Object.keys(scenario.overrides).filter((id) => !matched.has(id)) };
}
export function projectReplayStates(snapshot: ResearchSnapshot, base: readonly FabToolState[] = FAB_TOOL_STATES) {
  const states = [...base];
  const unmappedIndices: number[] = [];
  const e10: Record<string, FabToolState> = { PR_productive: 'running', SBY_standby: 'idle', ENG_engineering: 'idle', UDT_unscheduled_down: 'down', SDT_scheduled_down: 'maint' };
  TWIN_LAYOUT_IDENTITIES.forEach((identity, index) => {
    const state = identity.replayTarget ? snapshot.machineStates.get(identity.machineId) : undefined;
    if (state && e10[state]) states[index] = e10[state];
    else unmappedIndices.push(index);
  });
  return { states, mappedCount: FAB_LAYOUT.length - unmappedIndices.length, unmappedIndices };
}

export const DEMO_TICK_MS = 1600;
export interface DemoState { states: FabToolState[]; keys: Record<string, FabToolState>; referenceLights: Record<string, FabToolState>; telemetry: Record<string, Telemetry>; yieldJitter: number[]; cycle: number; playing: boolean; seed: number; scenarioId: string; unresolvedIds: string[] }
export type DemoEvent = { type: 'tick' } | { type: 'play'; playing: boolean }
  | { type: 'manual'; index: number; state: FabToolState }
  | { type: 'manual-key'; key: string; state: FabToolState }
  | { type: 'scenario'; scenario: ScenarioOverrides & { id: string } };
const originalSignals = buildOriginalSignalRegistry();
const originalSignalKeys = [...originalSignals.keys()];
function randomStream(initial: number) {
  let seed = initial >>> 0;
  return { random: () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }, seed: () => seed };
}
const sampleYieldJitter = (random: () => number) => Array.from({ length: 8 }, () => (random() - 0.5) * 0.003);
function refreshYield(state: DemoState): DemoState {
  const stream = randomStream(state.seed);
  return { ...state, yieldJitter: sampleYieldJitter(stream.random), seed: stream.seed() };
}
function applySignal(state: DemoState, key: string, value: FabToolState): DemoState {
  const target = originalSignals.get(key);
  const states = [...state.states];
  if (target?.layoutIndex !== undefined) states[target.layoutIndex] = value;
  return { ...state, states, keys: { ...state.keys, [key]: value },
    referenceLights: target?.referenceId ? { ...state.referenceLights, [target.referenceId]: value } : state.referenceLights };
}
export function createDemoState(seed = 42): DemoState {
  const stream = randomStream(seed);
  const telemetry = Object.fromEntries(ORIGINAL_TWIN_UI.equipment.map(eq => [eq.id, createProcessTelemetry(eq, stream.random)]));
  const keys = Object.fromEntries(ORIGINAL_TWIN_UI.equipment.map(eq => [eq.id, 'running' as const]));
  const yieldJitter = sampleYieldJitter(stream.random);
  return { states: FAB_LAYOUT.map(() => 'running'), keys, referenceLights: { ...keys }, telemetry, yieldJitter,
    cycle: 1, playing: true, seed: stream.seed(), scenarioId: 'baseline', unresolvedIds: [] };
}
export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  switch (event.type) {
    case 'play': return { ...state, playing: event.playing };
    case 'manual-key': return refreshYield(applySignal(state, event.key, event.state));
    case 'manual': {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= state.states.length) return state;
      const states = [...state.states];
      states[event.index] = event.state;
      return { ...state, states };
    }
    case 'scenario': {
      let next = state;
      // Original applyScenario resets the final directory only. Draft aliases
      // and their visible lamps retain earlier writes, even on Scenario reset.
      for (const row of ORIGINAL_TWIN_UI.equipment) next = applySignal(next, row.id,
        (event.scenario.overrides[row.id] ?? 'RUNNING').toLowerCase() as FabToolState);
      const keys = { ...next.keys };
      for (const [key, value] of Object.entries(event.scenario.overrides)) keys[key] = value.toLowerCase() as FabToolState;
      return refreshYield({ ...next, keys, scenarioId: event.scenario.id,
        unresolvedIds: Object.keys(event.scenario.overrides).filter(key => !originalSignals.has(key) && !ORIGINAL_TWIN_UI.equipment.some(row => row.id === key)) });
    }
    case 'tick': {
      if (!state.playing) return state;
      const cycle = state.cycle + 1;
      const stream = randomStream(state.seed);
      const telemetry = Object.fromEntries(ORIGINAL_TWIN_UI.equipment.map(eq => [eq.id,
        advanceProcessTelemetry(state.telemetry[eq.id], eq, cycle, state.keys[eq.id] === 'down', stream.random)]));
      let next = { ...state, telemetry };
      // Preserve source random consumption: 18x4 sensors, optional third-cycle
      // Andon key/transition, then eight cascading-yield samples.
      if (cycle % 3 === 0) {
        const key = originalSignalKeys[Math.floor(stream.random() * originalSignalKeys.length)];
        const current = state.keys[key] ?? 'running';
        if (current === 'running' && stream.random() < 0.28) next = applySignal(next, key, 'idle');
        else if (current === 'idle' && stream.random() < 0.65) next = applySignal(next, key, 'running');
      }
      const yieldJitter = sampleYieldJitter(stream.random);
      return { ...next, cycle, yieldJitter, seed: stream.seed() };
    }
  }
}
