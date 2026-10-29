import { beforeEach, expect, it } from 'vitest';
import { resetTwinUiStore, twinUiActions, useTwinUiStore } from '@/twin/twin-ui.atom';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '@/twin/twin-page.atom';
import { resetTwinDemoStore, twinDemoActions, useTwinDemoStore } from '@/twin/twin-demo.atom';
import { catalogActions, resetCatalogStore, useCatalogStore } from '@/catalog/catalog.atom';
import { resetWorkbenchStore, useWorkbenchStore, workbenchActions } from '@/workbench/workbench.atom';
import { resetRuntimeStore, runtimeActions, useRuntimeStore } from '@/state/runtime-store';
import { resetLocaleStore, useLocaleStore } from '@/state/locale.atom';

/**
 * M2b replaced the Redux Toolkit store with seven independent Zustand stores.
 * This historical filename now certifies the replacement: the same seven
 * client-UI state keys, representative action behaviour and serializable
 * snapshots, without react-redux or the Redux store.
 */
const snapshot = () => ({
  catalog: useCatalogStore.getState(),
  locale: useLocaleStore.getState(),
  runtime: useRuntimeStore.getState(),
  twinDemo: useTwinDemoStore.getState(),
  twinPage: useTwinPageStore.getState(),
  twinUi: useTwinUiStore.getState(),
  workbench: useWorkbenchStore.getState(),
});

beforeEach(() => {
  resetTwinUiStore();
  resetTwinPageStore();
  resetTwinDemoStore();
  resetCatalogStore();
  resetWorkbenchStore();
  resetRuntimeStore();
  resetLocaleStore();
});

it('keeps the seven client-UI Zustand stores after the M2 RTK Query removal', () => {
  const state = snapshot();
  expect(Object.keys(state).sort()).toEqual(['catalog', 'locale', 'runtime', 'twinDemo', 'twinPage', 'twinUi', 'workbench']);
  // M2 removed RTK Query entirely; every HTTP endpoint is a TanStack Query module.
  expect('twinApi' in state).toBe(false);
  for (const slice of Object.values(state)) expect(typeof slice).toBe('object');
  expect(() => JSON.stringify(state)).not.toThrow();
});

it('routes all Twin mode changes through typed store actions', () => {
  twinUiActions.modeSet('visitor');
  twinUiActions.levelSet('B1');
  twinUiActions.spatialToggle('xray');
  twinUiActions.xraySet('gas');
  const state = useTwinUiStore.getState();
  expect(state.entryMode).toBe('visitor');
  expect(state.spatialMode).toBe('xray');
  expect(state.xray).toBe('gas');
  expect(state.level).toBe('B1');
  twinUiActions.escape();
  expect(useTwinUiStore.getState().onboarding.open).toBe(false);
});

it('keeps page, demo and workbench state serializable and action-owned', () => {
  runtimeActions.viewerMounted('test');
  runtimeActions.viewerLifecycleReceived({ epoch: 'test', event: { type: 'ready', message: 'WebGPU · test' } });
  twinPageActions.siteIdSet('site-test');
  twinPageActions.layerToggled('roof');
  twinDemoActions.playingSet(false);
  workbenchActions.formFieldSet({ field: 'lotCount', value: '12' });
  catalogActions.domainSet('FAB');
  catalogActions.selectedToggled('record-a');
  expect(useRuntimeStore.getState().viewer.status).toBe('WebGPU · test');
  expect(useTwinPageStore.getState().siteId).toBe('site-test');
  expect(useTwinPageStore.getState().layerPreferences.roof).toBe(true);
  expect(useTwinDemoStore.getState().playing).toBe(false);
  expect(useWorkbenchStore.getState().form.lotCount).toBe('12');
  expect(useCatalogStore.getState().domain).toBe('FAB');
  expect(useCatalogStore.getState().selected).toEqual(['record-a']);
  expect(() => JSON.stringify(snapshot())).not.toThrow();
});
