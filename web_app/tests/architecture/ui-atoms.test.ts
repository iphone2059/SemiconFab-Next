import { resetCatalogState, resetLocaleState, resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState, resetWorkbenchState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { beforeEach, expect, it } from 'vitest';
import { twinUiActions, twinUiAtom } from '@/twin/twin-ui.atom';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';
import { workbenchAtom, workbenchActions } from '@/workbench/workbench.atom';
import { runtimeActions, runtimeAtom } from '@/state/runtime-store';
import { localeAtom } from '@/state/locale.atom';

/** Seven UI feature atoms share the supplied registry and retain typed behavior. */
const { registry } = createAtomTestScope();
const snapshot = () => ({
  catalog: registry.get(catalogAtom),
  locale: registry.get(localeAtom),
  runtime: registry.get(runtimeAtom),
  twinDemo: registry.get(twinDemoAtom),
  twinPage: registry.get(twinPageAtom),
  twinUi: registry.get(twinUiAtom),
  workbench: registry.get(workbenchAtom),
});

beforeEach(() => {
  resetTwinUiState(registry);
  resetTwinPageState(registry);
  resetTwinDemoState(registry);
  resetCatalogState(registry);
  resetWorkbenchState(registry);
  resetRuntimeState(registry);
  resetLocaleState(registry);
});

it('keeps seven serializable client UI feature atoms in one registry', () => {
  const state = snapshot();
  expect(Object.keys(state).sort()).toEqual(['catalog', 'locale', 'runtime', 'twinDemo', 'twinPage', 'twinUi', 'workbench']);
  // M2 removed RTK Query entirely; every HTTP endpoint is a TanStack Query module.
  expect('twinApi' in state).toBe(false);
  for (const slice of Object.values(state)) expect(typeof slice).toBe('object');
  expect(() => JSON.stringify(state)).not.toThrow();
});

it('routes all Twin mode changes through typed store actions', () => {
  twinUiActions.modeSet(registry, 'visitor');
  twinUiActions.levelSet(registry, 'B1');
  twinUiActions.spatialToggle(registry, 'xray');
  twinUiActions.xraySet(registry, 'gas');
  const state = registry.get(twinUiAtom);
  expect(state.entryMode).toBe('visitor');
  expect(state.spatialMode).toBe('xray');
  expect(state.xray).toBe('gas');
  expect(state.level).toBe('B1');
  twinUiActions.escape(registry);
  expect(registry.get(twinUiAtom).onboarding.open).toBe(false);
});

it('keeps page, demo and workbench state serializable and action-owned', () => {
  runtimeActions.viewerMounted(registry, 'test');
  runtimeActions.viewerLifecycleReceived(registry, { epoch: 'test', event: { type: 'ready', message: 'WebGPU · test' } });
  twinPageActions.siteIdSet(registry, 'site-test');
  twinPageActions.layerToggled(registry, 'roof');
  twinDemoActions.playingSet(registry, false);
  workbenchActions.formFieldSet(registry, { field: 'lotCount', value: '12' });
  catalogActions.domainSet(registry, 'FAB');
  catalogActions.selectedToggled(registry, 'record-a');
  expect(registry.get(runtimeAtom).viewer.status).toBe('WebGPU · test');
  expect(registry.get(twinPageAtom).siteId).toBe('site-test');
  expect(registry.get(twinPageAtom).layerPreferences.roof).toBe(true);
  expect(registry.get(twinDemoAtom).playing).toBe(false);
  expect(registry.get(workbenchAtom).form.lotCount).toBe('12');
  expect(registry.get(catalogAtom).domain).toBe('FAB');
  expect(registry.get(catalogAtom).selected).toEqual(['record-a']);
  expect(() => JSON.stringify(snapshot())).not.toThrow();
});
