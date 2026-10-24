import { FAB_LAYOUT, FAB_TOOL_STATES, type FabLayoutTool, type FabToolState } from './fab-layout';
import type { ResearchSnapshot } from './research-replay';

export interface LayoutIdentity {
  instanceId: string;
  recordId: string;
  machineId: string;
  replayTarget: boolean;
}

export interface ScenarioOverrides { overrides: Readonly<Record<string, 'RUNNING' | 'IDLE' | 'DOWN' | 'MAINT'>> }

// Original CATEGORY_BAYS + buildDraftGhosts insertion order. Packaging/Test aliases
// intentionally collide with Litho/Metrology: preserve the source Map's actual winner.
const MIMAC_GROUP: Record<string, string> = {
  lithography: 'TG01_LITHO', resist_track: 'TG02_TRACK', dry_etch: 'TG03_ETCH',
  thin_film_deposition: 'TG05_CVD', thermal_processing: 'TG07_FURN_DIFF',
  ion_implantation: 'TG09_IMPL_MED', cmp: 'TG11_CMP_OX', wet_clean: 'TG13_WET_BENCH',
  metrology: 'TG16_MET_CD', inspection: 'TG18_INSPECT', packaging: 'TG01_LITHO',
  test: 'TG16_MET_CD', other: 'TG14_WET_SINGLE',
};
const FAMILY_ORDER: Record<string, number> = {
  lithography: 0, resist_track: 0, thermal_processing: 1, cmp: 2, wet_clean: 2,
  thin_film_deposition: 3, dry_etch: 4, ion_implantation: 5,
  metrology: 6, inspection: 6, other: 6, packaging: 7, test: 7,
};

export function buildLayoutIdentities(layout: readonly FabLayoutTool[] = FAB_LAYOUT): LayoutIdentity[] {
  const bayCounts = new Map<string, number>();
  const rows = layout.map((tool, index) => {
    const ordinal = (bayCounts.get(tool.category) ?? 0) + 1;
    bayCounts.set(tool.category, ordinal);
    return { instanceId: `FAB-01/tool-${String(index + 1).padStart(3, '0')}`, recordId: tool.recordId,
      machineId: `${MIMAC_GROUP[tool.category]}_${String(ordinal).padStart(2, '0')}`, replayTarget: false };
  });
  const order = layout.map((tool, index) => ({ index,
    rank: tool.originalKind === 'catalog' ? -1 : FAMILY_ORDER[tool.category] ?? 6 }));
  order.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const winners = new Map<string, number>();
  for (const { index } of order) winners.set(rows[index].machineId, index);
  for (const row of rows) row.replayTarget = rows[winners.get(row.machineId)!] === row;
  return rows;
}

export const TWIN_LAYOUT_IDENTITIES = buildLayoutIdentities();

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
export interface DemoState { states: FabToolState[]; cycle: number; playing: boolean; seed: number; scenarioId: string; unresolvedIds: string[] }
export type DemoEvent = { type: 'tick' } | { type: 'play'; playing: boolean }
  | { type: 'manual'; index: number; state: FabToolState }
  | { type: 'scenario'; scenario: ScenarioOverrides & { id: string } };
export function createDemoState(seed = 42): DemoState {
  return { states: FAB_LAYOUT.map(() => 'running'), cycle: 1, playing: true, seed, scenarioId: 'baseline', unresolvedIds: [] };
}
export function demoReducer(state: DemoState, event: DemoEvent): DemoState {
  switch (event.type) {
    case 'play': return { ...state, playing: event.playing };
    case 'manual': {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= state.states.length) return state;
      const states = [...state.states];
      states[event.index] = event.state;
      return { ...state, states };
    }
    case 'scenario': return { ...state, ...resolveScenario(event.scenario), scenarioId: event.scenario.id };
    case 'tick': {
      if (!state.playing) return state;
      const cycle = state.cycle + 1;
      if (cycle % 3 !== 0) return { ...state, cycle };
      let seed = state.seed;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
      const index = Math.floor(random() * state.states.length);
      const chance = random();
      const states = [...state.states];
      if (states[index] === 'running' && chance < 0.28) states[index] = 'idle';
      else if (states[index] === 'idle' && chance < 0.65) states[index] = 'running';
      return { ...state, cycle, states, seed };
    }
  }
}
