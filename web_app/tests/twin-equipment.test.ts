import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FAB_LAYOUT } from '../src/fab-layout';
import { buildLayoutIdentities, projectReplayStates, createDemoState, demoReducer, resolveScenario } from '../src/twin-equipment';
import { ResearchReplay } from '../src/research-replay';
import { YIELD_SCENARIOS } from '../src/fab-yield';

it('reproduces all original instance aliases and last-writer collision targets', () => {
  const reference = JSON.parse(readFileSync(new URL('../../docs/migration/twin-parity/layout-identities.json', import.meta.url), 'utf8'));
  const actual = buildLayoutIdentities();
  expect(actual).toHaveLength(121);
  expect(new Set(actual.map((row) => row.instanceId)).size).toBe(121);
  actual.forEach((row, index) => expect(row).toMatchObject({ instanceId: reference[index].instance_id, machineId: reference[index].machine_id, replayTarget: reference[index].original_replay_target }));
});

it('projects exact machine states to original alias winners and exposes unmapped instances', () => {
  const replay = ResearchReplay.parse([
    { timestamp_sec: 0, event_type: 'tool_state_change', payload: { machine_id: 'TG01_LITHO_03', tool_group_id: 'TG01_LITHO', semi_e10_state: 'UDT_unscheduled_down' } },
    { timestamp_sec: 1, event_type: 'tool_state_change', payload: { machine_id: 'TG02_TRACK_01', tool_group_id: 'TG02_TRACK', semi_e10_state: 'PR_productive' } },
  ].map((event) => JSON.stringify(event)).join('\n'));
  const projection = projectReplayStates(replay.snapshot(1), FAB_LAYOUT.map(() => 'maint'));
  // Packaging aliases overwrite Lithography 03 in the ORIGINAL Map.
  expect(projection.states[2]).toBe('maint');
  expect(projection.states[100]).toBe('down');
  expect(projection.states[8]).toBe('running');
  expect(projection.mappedCount).toBe(2);
  expect(projection.unmappedIndices).toHaveLength(119);
});

it('does not invent a category match for obsolete concrete scenario IDs', () => {
  const scenario = YIELD_SCENARIOS.find((row) => row.id === 'etch_down')!;
  const result = resolveScenario(scenario);
  expect(result.states.filter((state) => state === 'down')).toHaveLength(0);
  expect(result.unresolvedIds).toEqual(['fe.etch.ccp.2', 'fe.etch.icp.1', 'fe.clean.single.1']);
});

it('applies known exact IDs, reports unknown IDs, and updates repeated instances explicitly', () => {
  const result = resolveScenario({ overrides: { [FAB_LAYOUT[8].recordId]: 'IDLE', missing: 'DOWN' } });
  expect(result.states[8]).toBe('idle');
  expect(result.states[10]).toBe('idle');
  expect(result.unresolvedIds).toEqual(['missing']);
});

it('pauses ticks, changes only RUNNING/IDLE on the original third-cycle cadence, and accepts manual instance state', () => {
  let state = createDemoState(42);
  state = demoReducer(state, { type: 'manual', index: 2, state: 'down' });
  state = demoReducer(state, { type: 'play', playing: false });
  expect(demoReducer(state, { type: 'tick' })).toBe(state);
  state = demoReducer(state, { type: 'play', playing: true });
  state = demoReducer(state, { type: 'tick' });
  expect(state.cycle).toBe(2);
  expect(state.states[2]).toBe('down');
  const sameSeed = demoReducer(demoReducer(createDemoState(42), { type: 'tick' }), { type: 'tick' });
  expect(demoReducer(demoReducer(createDemoState(42), { type: 'tick' }), { type: 'tick' })).toEqual(sameSeed);
  expect(demoReducer(state, { type: 'manual', index: 121, state: 'running' })).toBe(state);
});

it('updates a source UUID light target without changing every instance of that model', () => {
  const initial=createDemoState(42);
  const state=demoReducer(initial,{type:'manual-key',key:FAB_LAYOUT[8].recordId,state:'idle'});
  expect(state.states[8]).toBe('running');
  expect(state.states[14]).toBe('idle');
  expect(state.keys[FAB_LAYOUT[8].recordId]).toBe('idle');
});

it('keeps draft lamp states across source scenario reset while resetting directory tools', () => {
  let state=demoReducer(createDemoState(42),{type:'manual-key',key:'TG01_LITHO_03',state:'idle'});
  state=demoReducer(state,{type:'manual-key',key:FAB_LAYOUT[52].recordId,state:'down'});
  state=demoReducer(state,{type:'scenario',scenario:YIELD_SCENARIOS[0]});
  expect(state.states[100]).toBe('idle');
  expect(state.states[52]).toBe('running');
  expect(state.keys[FAB_LAYOUT[52].recordId]).toBe('running');
});
