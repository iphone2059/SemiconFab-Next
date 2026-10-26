import { beforeEach, expect, it } from 'vitest';
import { resetRuntimeStore, runtimeActions, useRuntimeStore } from '../src/state/runtimeStore';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '../src/state/twinPageStore';
import { resetTwinUiStore, twinUiActions } from '../src/state/twinUiStore';
import { catalogActions, resetCatalogStore, useCatalogStore } from '../src/state/catalogStore';
import { resetWorkbenchStore, useWorkbenchStore, workbenchActions } from '../src/state/workbenchStore';
import { localeActions, resetLocaleStore, useLocaleStore } from '../src/state/localeStore';
import { createWaferTimeline } from '../src/tour-wafer-timeline';
import { buildWaferScenario } from '../src/wafer-scenario';
import { parseWaferRoutes } from '../src/wafer-route';
import { readFileSync } from 'node:fs';

beforeEach(() => {
  resetRuntimeStore();
  resetTwinPageStore();
  resetTwinUiStore();
  resetCatalogStore();
  resetWorkbenchStore();
  resetLocaleStore();
});

it('owns viewer lifecycle and hover in the runtime store and ignores callbacks from replaced scenes', () => {
  runtimeActions.viewerMounted('old');
  runtimeActions.viewerMounted('current');
  runtimeActions.viewerStatusReceived({ epoch: 'old', status: 'obsolete error' });
  expect(useRuntimeStore.getState().viewer.status).not.toBe('obsolete error');
  runtimeActions.viewerStatusReceived({ epoch: 'current', status: 'WebGPU · ready' });
  runtimeActions.viewerReloadRequested();
  runtimeActions.viewerStatusReceived({ epoch: 'current', status: 'WebGPU · stale' });
  expect(useRuntimeStore.getState().viewer.generation).toBe(1);
  expect(useRuntimeStore.getState().viewer.status).not.toContain('stale');
  expect(useRuntimeStore.getState().viewer.hover).toBeUndefined();
});

it('projects controller HUD into the twin page store and clears the panel on close', () => {
  const routes = parseWaferRoutes(JSON.parse(readFileSync(new URL('../public/twin/routes.json', import.meta.url), 'utf8')));
  const timeline = createWaferTimeline(buildWaferScenario(routes, 'en'));
  timeline.setProduct('B');
  const frame = timeline.readFrame();
  twinPageActions.waferFrameReceived({ product: 'B', index: frame.index, hud: frame.hud, completed: false });
  expect(useTwinPageStore.getState().wafer).toMatchObject({ product: 'B', index: 0, hud: { step: 'Step 1/104', status: 'Navigating...' } });
  // Closing the wafer HUD is a Twin-UI action that also clears the page frame.
  twinUiActions.waferClose();
  expect(useTwinPageStore.getState().wafer.hud).toBeUndefined();
  expect(() => JSON.stringify(useTwinPageStore.getState())).not.toThrow();
});

it('invalidates an in-flight local import when returning to server data', () => {
  catalogActions.importStarted('import-a');
  catalogActions.importFailed({ requestId: 'import-a', error: 'invalid JSON' });
  catalogActions.localImportCleared();
  catalogActions.localImportApplied({ requestId: 'import-a', entries: [], importId: 'stale.json' });
  expect(useCatalogStore.getState().localEntries).toBeNull();
  expect(useCatalogStore.getState().importError).toBe('');
  expect(useCatalogStore.getState().importPending).toBe(false);
});

it('retains an idempotency key for retry and rejects late submission completion after a site switch', () => {
  workbenchActions.siteIdSet('a');
  workbenchActions.submissionPrepared({ json: 'request', key: 'key-1' });
  workbenchActions.submissionPrepared({ json: 'request', key: 'key-2' });
  expect(useWorkbenchStore.getState().pendingSubmission?.key).toBe('key-1');
  workbenchActions.siteIdSet('b');
  workbenchActions.submissionCompleted({ siteId: 'a', key: 'key-1', runId: 'a-run' });
  expect(useWorkbenchStore.getState().runId).toBe('');
  expect(useWorkbenchStore.getState().pendingSubmission).toBeUndefined();
});

it('has a single language/theme authority shared by catalog and Twin', () => {
  localeActions.preferencesSet({ language: 'en', theme: 'dark' });
  localeActions.themeToggled();
  expect(useLocaleStore.getState()).toEqual({ language: 'en', theme: 'light' });
  expect(useCatalogStore.getState()).not.toHaveProperty('preferences');
});
