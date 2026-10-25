import { configureStore } from '@reduxjs/toolkit';
import { expect, it } from 'vitest';
import { runtimeSlice, runtimeActions } from '../src/store/runtimeSlice';
import { twinPageSlice, twinPageActions, twinUiActions } from '../src/store/twinUiSlice';
import { catalogSlice, catalogActions } from '../src/store/catalogSlice';
import { workbenchSlice, workbenchActions } from '../src/store/workbenchSlice';
import { localeSlice, localeActions } from '../src/store/localeSlice';
import type { WaferWaypoint } from '../src/wafer-route';

it('owns viewer lifecycle and hover in Redux and ignores callbacks from replaced scenes', () => {
  const store = configureStore({ reducer: runtimeSlice.reducer });
  store.dispatch(runtimeActions.viewerMounted('old'));
  store.dispatch(runtimeActions.viewerMounted('current'));
  store.dispatch(runtimeActions.viewerStatusReceived({ epoch: 'old', status: 'obsolete error' }));
  expect(store.getState().viewer.status).not.toBe('obsolete error');
  store.dispatch(runtimeActions.viewerStatusReceived({ epoch: 'current', status: 'WebGPU · ready' }));
  store.dispatch(runtimeActions.viewerReloadRequested());
  store.dispatch(runtimeActions.viewerStatusReceived({ epoch: 'current', status: 'WebGPU · stale' }));
  expect(store.getState().viewer.generation).toBe(1);
  expect(store.getState().viewer.status).not.toContain('stale');
  expect(store.getState().viewer.hover).toBeUndefined();
});

it('owns wafer progress and bounded trail, and clears them on seek, product change and close', () => {
  const store = configureStore({ reducer: twinPageSlice.reducer });
  const waypoints: WaferWaypoint[] = Array.from({ length: 4 }, (_, index) => ({ step: index + 1, toolGroup: 'TG', category: 'other', x: index * 10, y: 2.5, z: 0 }));
  for (let i = 0; i < 5; i++) store.dispatch(twinPageActions.waferFrameAdvanced({ deltaSec: 0.1, speed: 4, waypoints }));
  expect(store.getState().wafer.index).toBe(1);
  expect(store.getState().wafer.trail.length).toBeGreaterThan(0);
  store.dispatch(twinPageActions.waferIndexSet(2));
  expect(store.getState().wafer.progress).toBe(0);
  store.dispatch(twinPageActions.waferFrameAdvanced({ deltaSec: 0.1, speed: 1, waypoints }));
  expect(store.getState().wafer.progress).toBeCloseTo(0.05);
  store.dispatch(twinPageActions.waferProductSet('B'));
  expect(store.getState().wafer).toMatchObject({ product: 'B', index: 0, progress: 0, trail: [] });
  store.dispatch(twinPageActions.waferFrameAdvanced({ deltaSec: 0.1, speed: 1, waypoints }));
  store.dispatch(twinUiActions.waferClose());
  expect(store.getState().wafer).toMatchObject({ progress: 0, trail: [] });
  expect(() => JSON.stringify(store.getState())).not.toThrow();
});

it('invalidates an in-flight local import when returning to server data', () => {
  const store = configureStore({ reducer: catalogSlice.reducer });
  store.dispatch(catalogActions.importStarted('import-a'));
  store.dispatch(catalogActions.importErrorSet('invalid JSON'));
  store.dispatch(catalogActions.localImportCleared());
  store.dispatch(catalogActions.localImportApplied({ requestId: 'import-a', entries: [], importId: 'stale.json' }));
  expect(store.getState().localEntries).toBeNull();
  expect(store.getState().importError).toBe('');
  expect(store.getState().importPending).toBe(false);
});

it('retains an idempotency key for retry and rejects late submission completion after a site switch', () => {
  const store = configureStore({ reducer: workbenchSlice.reducer });
  store.dispatch(workbenchActions.siteIdSet('a'));
  store.dispatch(workbenchActions.submissionPrepared({ json: 'request', key: 'key-1' }));
  store.dispatch(workbenchActions.submissionPrepared({ json: 'request', key: 'key-2' }));
  expect(store.getState().pendingSubmission?.key).toBe('key-1');
  store.dispatch(workbenchActions.siteIdSet('b'));
  store.dispatch(workbenchActions.submissionCompleted({ siteId: 'a', key: 'key-1', runId: 'a-run' }));
  expect(store.getState().runId).toBe('');
  expect(store.getState().pendingSubmission).toBeUndefined();
});

it('has a single language/theme authority shared by catalog and Twin', () => {
  const store = configureStore({ reducer: { locale: localeSlice.reducer, catalog: catalogSlice.reducer } });
  store.dispatch(localeActions.preferencesSet({ language: 'en', theme: 'dark' }));
  store.dispatch(localeActions.themeToggled());
  expect(store.getState().locale).toEqual({ language: 'en', theme: 'light' });
  expect(store.getState().catalog).not.toHaveProperty('preferences');
});
