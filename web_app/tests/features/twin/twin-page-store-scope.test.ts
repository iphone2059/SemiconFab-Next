import { resetTwinPageState } from '../../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
import { afterEach, expect, it } from 'vitest';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState, type FabLayoutTool } from '@/domain/fab-layout';
import { createMesJob } from '@/domain/fab-process-control';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';

/**
 * A01: the Twin page store may only hold a FAB-scoped projection that carries an
 * explicit composite scope key (siteId + fabId). Frames and stale flags from
 * another scope are dropped, and activating a scope clears every FAB-scoped
 * projection atomically.
 */

const { registry } = createAtomTestScope();
const scopeA = { siteId: 'site-1', fabId: 'fab-a' };
const foreignScope = { siteId: 'site-1', fabId: 'unknown-fab' };

const createJobTool = (index: number): FabLayoutTool => FAB_LAYOUT[index];

const statesWith = (first: FabToolState): FabToolState[] =>
  FAB_TOOL_STATES.map((state, index) => (index === 0 ? first : state));

afterEach(() => resetTwinPageState(registry));

it('stores the live projection under an explicit composite scope and ignores other scopes', () => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  expect(registry.get(twinPageAtom).liveStatusScope).toEqual(scopeA);
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down');
  expect(registry.get(twinPageAtom).statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:00Z', stale: false });

  // A coalesced batch from another FAB (or a late callback after a switch) must
  // never apply, even when its siteId is identical.
  twinPageActions.liveSnapshotReceived(registry, { scope: foreignScope, states: statesWith('maint'), updatedAt: '2026-10-27T00:00:01Z' });
  expect(registry.get(twinPageAtom).liveStatusScope).toEqual(scopeA);
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down');
  expect(registry.get(twinPageAtom).statusFeed?.updatedAt).toBe('2026-10-27T00:00:00Z');
});

it('marks the feed stale only for the active scope (never labels a stale stream LIVE)', () => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('running'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.statusFeedStale(registry, { scope: foreignScope });
  expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(false);
  twinPageActions.statusFeedStale(registry, { scope: scopeA });
  expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(true);
});

it('clears tool states, status feed and MES demo state when the same FAB scope is reactivated', () => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.statusFeedStale(registry, { scope: scopeA });
  twinPageActions.mesJobSet(registry, { index: 3, job: createMesJob(createJobTool(3), 3, 1000) });
  twinPageActions.inspectorMesSet(registry, { id: 'ref-tool', job: createMesJob(createJobTool(4), 4, 1000) });

  twinPageActions.liveScopeActivated(registry, scopeA);
  const state = registry.get(twinPageAtom);
  expect(state.liveStatusScope).toEqual(scopeA);
  expect(state.liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(state.statusFeed).toBeUndefined();
  expect(state.mesJobs).toEqual({});
  expect(state.inspectorMes).toEqual({});
});

it('fully resets the FAB-scoped state through resetTwinPageState(registry)', () => {
  twinPageActions.liveScopeActivated(registry, scopeA);
  twinPageActions.liveSnapshotReceived(registry, { scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.mesJobSet(registry, { index: 0, job: createMesJob(createJobTool(0), 0, 1000) });
  resetTwinPageState(registry);
  const state = registry.get(twinPageAtom);
  expect(state.liveStatusScope).toBeUndefined();
  expect(state.liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(state.statusFeed).toBeUndefined();
  expect(state.mesJobs).toEqual({});
  expect(state.inspectorMes).toEqual({});
  expect(state).not.toHaveProperty('tourRemainingMs');
});
