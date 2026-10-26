import { expect, it } from 'vitest';
import { store } from '../src/store/store';
import { twinApi } from '../src/store/api';
import { twinUiActions, twinPageActions } from '../src/store/twinUiSlice';
import { twinDemoActions } from '../src/store/twinDemoSlice';
import { workbenchActions } from '../src/store/workbenchSlice';
import { catalogActions } from '../src/store/catalogSlice';
import { runtimeActions } from '../src/store/runtimeSlice';

it('configures Redux Toolkit, RTK Query middleware and domain slices', () => {
  const state = store.getState();
  expect(Object.keys(state).sort()).toEqual(['catalog', 'locale', 'runtime', 'twinApi', 'twinDemo', 'twinPage', 'twinUi', 'workbench']);
  expect(state.twinApi).toBeDefined();
  expect(typeof store.dispatch).toBe('function');
  expect(twinApi.reducerPath).toBe('twinApi');
  // ARCH G-02: /api/v1/sites moved to TanStack Query; the RTK cache must not keep a second copy.
  expect('getSites' in twinApi.endpoints).toBe(false);
  expect(twinApi.endpoints.getEquipmentStatus).toBeDefined();
  expect(twinApi.endpoints.getWaferRoutes).toBeDefined();
  expect(twinApi.endpoints.createRun).toBeDefined();
});

it('routes all Twin mode changes through typed slice actions', () => {
  store.dispatch(twinUiActions.modeSet('visitor'));
  store.dispatch(twinUiActions.levelSet('B1'));
  store.dispatch(twinUiActions.spatialToggle('xray'));
  store.dispatch(twinUiActions.xraySet('gas'));
  const state = store.getState().twinUi;
  expect(state.entryMode).toBe('visitor');
  expect(state.spatialMode).toBe('xray');
  expect(state.xray).toBe('gas');
  expect(state.level).toBe('B1');
  store.dispatch(twinUiActions.escape());
  expect(store.getState().twinUi.onboarding.open).toBe(false);
});

it('keeps page, demo and workbench state serializable and action-owned', () => {
  store.dispatch(runtimeActions.viewerMounted('test'));
  store.dispatch(runtimeActions.viewerStatusReceived({ epoch: 'test', status: 'WebGPU · test' }));
  store.dispatch(twinPageActions.siteIdSet('site-test'));
  store.dispatch(twinPageActions.layerToggled('roof'));
  store.dispatch(twinDemoActions.playingSet(false));
  store.dispatch(workbenchActions.formFieldSet({ field: 'lotCount', value: '12' }));
  store.dispatch(catalogActions.domainSet('FAB'));
  store.dispatch(catalogActions.selectedToggled('record-a'));
  const state = store.getState();
  expect(state.runtime.viewer.status).toBe('WebGPU · test');
  expect(state.twinPage.siteId).toBe('site-test');
  expect(state.twinPage.layerPreferences.roof).toBe(true);
  expect(state.twinDemo.playing).toBe(false);
  expect(state.workbench.form.lotCount).toBe('12');
  expect(state.catalog.domain).toBe('FAB');
  expect(state.catalog.selected).toEqual(['record-a']);
  expect(() => JSON.stringify(state)).not.toThrow();
});
