import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import { TWIN_LAYOUT_IDENTITIES } from '@/domain/fab-layout-identities';
import { ResearchReplay } from '@/domain/simulation-research-replay';
import { projectReplayStates } from '@/domain/simulation-twin-equipment';
import { twinPageActions, twinPageAtom, type TwinFabState } from '@/twin/twin-page.atom';

const registry = AtomRegistry.make();
beforeEach(() => registry.reset());
afterAll(() => registry.dispose());
const scopeA = { siteId: 'site-1', fabId: 'fab-a' };
const statesWith = (state: FabToolState): FabToolState[] => FAB_TOOL_STATES.map(() => state);

it.each([
  { siteId: 'site-1', fabId: 'fab-b' },
  { siteId: 'site-2', fabId: 'fab-a' },
])('atomically resets the replay baseline on A → $siteId/$fabId → A', (scopeB) => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.replayBaseSet(registry, statesWith('down'));
  const seen: TwinFabState[] = [];
  const unsubscribe = registry.subscribe(twinPageAtom, (state) => seen.push(state));
  try {
    twinPageActions.liveScopeActivated(registry, scopeB);
    expect(seen).toHaveLength(1);
    expect(seen[0].liveStatusScope).toEqual(scopeB);
    expect(seen[0].liveToolStates).toEqual(FAB_TOOL_STATES);
    expect(seen[0].replayBase).toEqual(FAB_TOOL_STATES);

    twinPageActions.replayBaseSet(registry, statesWith('maint'));
    twinPageActions.liveScopeActivated(registry, scopeA);
    expect(registry.get(twinPageAtom).replayBase).toEqual(FAB_TOOL_STATES);
    // No scope-indexed cache: returning to A cannot resurrect either old baseline.
    twinPageActions.liveSnapshotReceived(registry, { scope: scopeB, states: statesWith('down'), updatedAt: 'late' });
    expect(registry.get(twinPageAtom).replayBase).toEqual(FAB_TOOL_STATES);
  } finally { unsubscribe(); }
});

it('keeps an explicitly captured baseline fixed across live frames and same-scope reactivation', () => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  const captured = statesWith('maint');
  twinPageActions.replayBaseSet(registry, captured);
  const baseline = registry.get(twinPageAtom).replayBase;
  captured[0] = 'down';
  expect(baseline[0]).toBe('maint');
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('running'), updatedAt: 'first' });
  twinPageActions.liveScopeActivated(registry, { ...scopeA });
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('idle'), updatedAt: 'second' });
  expect(registry.get(twinPageAtom).replayBase).toBe(baseline);
});

it('uses the new FAB default for unmapped research equipment, never the old FAB or later live frames', () => {
  const mapped = TWIN_LAYOUT_IDENTITIES.findIndex((identity) => identity.replayTarget);
  const unmapped = TWIN_LAYOUT_IDENTITIES.findIndex((identity) => !identity.replayTarget);
  expect(mapped).toBeGreaterThanOrEqual(0);
  expect(unmapped).toBeGreaterThanOrEqual(0);
  const replay = ResearchReplay.parse(JSON.stringify({
    timestamp_sec: 0, event_type: 'tool_state_change',
    payload: { machine_id: TWIN_LAYOUT_IDENTITIES[mapped].machineId, tool_group_id: 'TG', semi_e10_state: 'UDT_unscheduled_down' },
  }));
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.replayBaseSet(registry, statesWith('maint'));
  const scopeB = { siteId: 'site-1', fabId: 'fab-b' };
  twinPageActions.liveScopeActivated(registry, scopeB);
  const baseline = registry.get(twinPageAtom).replayBase;
  const projected = projectReplayStates(replay.snapshot(0), baseline);
  expect(projected.states[mapped]).toBe('down');
  expect(projected.unmappedIndices).toContain(unmapped);
  expect(projected.states[unmapped]).toBe(FAB_TOOL_STATES[unmapped]);
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeB, states: statesWith('idle'), updatedAt: 'new live' });
  expect(registry.get(twinPageAtom).replayBase).toBe(baseline);
  expect(projectReplayStates(replay.snapshot(0), baseline)).toEqual(projected);
});
