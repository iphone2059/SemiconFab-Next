import { afterEach, expect, it } from 'vitest';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState, type FabLayoutTool } from '../src/fab-layout';
import { createMesJob } from '../src/process-control';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '../src/state/twinPageStore';

/**
 * A01: the Twin page store may only hold a FAB-scoped projection that carries an
 * explicit composite scope key (siteId + fabId). Frames and stale flags from
 * another scope are dropped, and activating a scope clears every FAB-scoped
 * projection atomically.
 */

const scopeA = { siteId: 'site-1', fabId: 'fab-a' };
const scopeB = { siteId: 'site-1', fabId: 'fab-b' };

const createJobTool = (index: number): FabLayoutTool => FAB_LAYOUT[index];

const statesWith = (first: FabToolState): FabToolState[] =>
  FAB_TOOL_STATES.map((state, index) => (index === 0 ? first : state));

afterEach(() => resetTwinPageStore());

it('stores the live projection under an explicit composite scope and ignores other scopes', () => {
  twinPageActions.liveScopeActivated(scopeA);
  twinPageActions.liveSnapshotReceived({ scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  expect(useTwinPageStore.getState().liveStatusScope).toEqual(scopeA);
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down');
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:00Z', stale: false });

  // A coalesced batch from another FAB (or a late callback after a switch) must
  // never apply, even when its siteId is identical.
  twinPageActions.liveSnapshotReceived({ scope: scopeB, states: statesWith('maint'), updatedAt: '2026-10-27T00:00:01Z' });
  expect(useTwinPageStore.getState().liveStatusScope).toEqual(scopeA);
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down');
  expect(useTwinPageStore.getState().statusFeed?.updatedAt).toBe('2026-10-27T00:00:00Z');
});

it('marks the feed stale only for the active scope (never labels a stale stream LIVE)', () => {
  twinPageActions.liveScopeActivated(scopeA);
  twinPageActions.liveSnapshotReceived({ scope: scopeA, states: statesWith('running'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.statusFeedStale({ scope: scopeB });
  expect(useTwinPageStore.getState().statusFeed?.stale).toBe(false);
  twinPageActions.statusFeedStale({ scope: scopeA });
  expect(useTwinPageStore.getState().statusFeed?.stale).toBe(true);
});

it('clears tool states, status feed and MES demo state when the FAB scope is activated', () => {
  twinPageActions.liveScopeActivated(scopeA);
  twinPageActions.liveSnapshotReceived({ scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.statusFeedStale({ scope: scopeA });
  twinPageActions.mesJobSet({ index: 3, job: createMesJob(createJobTool(3), 3) });
  twinPageActions.inspectorMesSet({ id: 'ref-tool', job: createMesJob(createJobTool(4), 4) });

  twinPageActions.liveScopeActivated(scopeB);
  const state = useTwinPageStore.getState();
  expect(state.liveStatusScope).toEqual(scopeB);
  expect(state.liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(state.statusFeed).toBeUndefined();
  expect(state.mesJobs).toEqual({});
  expect(state.inspectorMes).toEqual({});
});

it('fully resets the FAB-scoped state through resetTwinPageStore()', () => {
  twinPageActions.liveScopeActivated(scopeA);
  twinPageActions.liveSnapshotReceived({ scope: scopeA, states: statesWith('down'), updatedAt: '2026-10-27T00:00:00Z' });
  twinPageActions.mesJobSet({ index: 0, job: createMesJob(createJobTool(0), 0) });
  resetTwinPageStore();
  const state = useTwinPageStore.getState();
  expect(state.liveStatusScope).toBeUndefined();
  expect(state.liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(state.statusFeed).toBeUndefined();
  expect(state.mesJobs).toEqual({});
  expect(state.inspectorMes).toEqual({});
  expect(state).not.toHaveProperty('tourRemainingMs');
});
