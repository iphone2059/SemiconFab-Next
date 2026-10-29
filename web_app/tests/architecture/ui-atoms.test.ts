import { resetCatalogState, resetLocaleState, resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState, resetWorkbenchState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import * as Atom from 'effect/reactivity/Atom';
import { beforeEach, expect, it } from 'vitest';
import { twinUiActions, twinUiAtom } from '@/twin/twin-ui.atom';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';
import { twinPageUiActions, twinPageUiAtom } from '@/twin/twin-page-ui.atom';
import { twinWaferAtom } from '@/twin/twin-wafer.atom';
import { twinYmsAtom } from '@/twin/twin-yms.atom';
import { twinAmhsAtom } from '@/twin/twin-amhs.atom';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';
import { workbenchAtom, workbenchActions } from '@/workbench/workbench.atom';
import { runtimeAtom } from '@/state/runtime.atom';
import { viewerActions, viewerSessionAtom } from '@/state/viewer.atom';
import { localeAtom } from '@/state/locale.atom';

/** Every Twin/UI feature atom shares the supplied registry and retains typed behavior. */
const { registry } = createAtomTestScope();
const snapshot = () => ({
  catalog: registry.get(catalogAtom),
  locale: registry.get(localeAtom),
  runtime: registry.get(runtimeAtom),
  viewer: registry.get(viewerSessionAtom),
  twinDemo: registry.get(twinDemoAtom),
  twinPage: registry.get(twinPageAtom),
  twinPageUi: registry.get(twinPageUiAtom),
  twinUi: registry.get(twinUiAtom),
  twinWafer: registry.get(twinWaferAtom),
  twinYms: registry.get(twinYmsAtom),
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

it('keeps eleven serializable client UI feature atoms in one registry', () => {
  const state = snapshot();
  expect(Object.keys(state).sort()).toEqual(['catalog', 'locale', 'runtime', 'twinDemo', 'twinPage', 'twinPageUi', 'twinUi', 'twinWafer', 'twinYms', 'viewer', 'workbench']);
  // AMHS scene statistics start empty (the HUD renders its own zero defaults) and are
  // therefore asserted separately from the serializable snapshot above.
  expect(Atom.isAtom(twinAmhsAtom)).toBe(true);
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
  viewerActions.viewerMounted(registry, 'test');
  viewerActions.viewerLifecycleReceived(registry, { epoch: 'test', event: { type: 'ready', message: 'WebGPU · test' } });
  twinPageActions.siteIdSet(registry, 'site-test');
  twinPageUiActions.layerToggled(registry, 'roof');
  twinDemoActions.playingSet(registry, false);
  workbenchActions.formFieldSet(registry, { field: 'lotCount', value: '12' });
  catalogActions.domainSet(registry, 'FAB');
  catalogActions.selectedToggled(registry, 'record-a');
  expect(registry.get(viewerSessionAtom).status).toBe('WebGPU · test');
  expect(registry.get(twinPageAtom).siteId).toBe('site-test');
  expect(registry.get(twinPageUiAtom).layerPreferences.roof).toBe(true);
  expect(registry.get(twinDemoAtom).playing).toBe(false);
  expect(registry.get(workbenchAtom).form.lotCount).toBe('12');
  expect(registry.get(catalogAtom).domain).toBe('FAB');
  expect(registry.get(catalogAtom).selected).toEqual(['record-a']);
  expect(() => JSON.stringify(snapshot())).not.toThrow();
});
