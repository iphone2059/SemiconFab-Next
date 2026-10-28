import { beforeEach, expect, it } from 'vitest';
import { resetRuntimeStore, runtimeActions, useRuntimeStore } from '../src/state/runtimeStore';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '../src/features/twin/state/twinPageStore';
import { resetTwinUiStore, twinUiActions, useTwinUiStore } from '../src/features/twin/state/twinUiStore';
import { catalogActions, resetCatalogStore, useCatalogStore } from '../src/features/catalog/state/catalogStore';
import { resetWorkbenchStore, useWorkbenchStore, workbenchActions } from '../src/features/workbench/state/workbenchStore';
import { localeActions, resetLocaleStore, useLocaleStore } from '../src/state/localeStore';
import { createWaferTimeline } from '../src/domain/wafer/wafer-timeline';
import { buildWaferScenario } from '../src/domain/wafer/wafer-scenario';
import { parseWaferRoutes } from '../src/domain/wafer/wafer-route';
import { closeWaferSession } from '../src/features/twin/wafer-session';
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
  runtimeActions.viewerLifecycleReceived({ epoch: 'old', event: { type: 'failed', message: 'obsolete error', error: new Error('obsolete error') } });
  expect(useRuntimeStore.getState().viewer.status).not.toBe('obsolete error');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('initializing');
  runtimeActions.viewerLifecycleReceived({ epoch: 'current', event: { type: 'ready', message: 'WebGPU · ready' } });
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('ready');
  runtimeActions.viewerReloadRequested();
  runtimeActions.viewerLifecycleReceived({ epoch: 'current', event: { type: 'ready', message: 'WebGPU · stale' } });
  expect(useRuntimeStore.getState().viewer.generation).toBe(1);
  expect(useRuntimeStore.getState().viewer.status).not.toContain('stale');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('idle');
  expect(useRuntimeStore.getState().viewer.hover).toBeUndefined();
  // The lifecycle enum, not the display text, owns the control state after unmount. The
  // reload cleared the epoch first, so the stale unmount of the replaced viewer is ignored.
  runtimeActions.viewerUnmounted('current');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('idle');
  runtimeActions.viewerMounted('next');
  runtimeActions.viewerUnmounted('next');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('disposed');
  expect(useRuntimeStore.getState().viewer.status).not.toBe('WebGPU · stale');
});

it('projects controller HUD into the page store and closes the coordinated wafer session explicitly', () => {
  const routes = parseWaferRoutes(JSON.parse(readFileSync(new URL('../public/twin/routes.json', import.meta.url), 'utf8')));
  const timeline = createWaferTimeline(buildWaferScenario(routes, 'en'));
  timeline.setProduct('B');
  const frame = timeline.readFrame();
  twinUiActions.waferOpen();
  twinPageActions.waferFrameReceived({ product: 'B', index: frame.index, hud: frame.hud, completed: true });
  expect(useTwinPageStore.getState().wafer).toMatchObject({ product: 'B', index: 0, hud: { step: 'Step 1/104', status: 'Navigating...' } });
  expect(useTwinUiStore.getState().wafer).toMatchObject({ active: true, playing: true });

  // The Twin UI store owns close/playback only. Closing it must never mutate the
  // page store through a hidden cross-store call.
  twinUiActions.waferClose();
  expect(useTwinUiStore.getState().wafer).toMatchObject({ active: false, playing: false });
  expect(useTwinPageStore.getState().wafer.hud).toBeDefined();
  expect(useTwinPageStore.getState().wafer.completed).toBe(true);

  // The application-level use case coordinates both stores; the scene cleanup
  // stays with the wafer playback controller/page caller.
  closeWaferSession();
  expect(useTwinPageStore.getState().wafer.hud).toBeUndefined();
  expect(useTwinPageStore.getState().wafer.completed).toBe(false);
  expect(useTwinUiStore.getState().wafer).toMatchObject({ active: false, playing: false });
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

it('keeps only client UI state in the Workbench store (no parallel server/command cache)', () => {
  workbenchActions.siteIdSet('a');
  workbenchActions.runIdSet('a-run');
  workbenchActions.formFieldSet({ field: 'lotCount', value: '12' });
  workbenchActions.submitErrorSet('submit failed');

  // A site switch clears the server-run selection and transient error, but keeps
  // the local form draft (the user may retarget the run).
  workbenchActions.siteIdSet('b');
  expect(useWorkbenchStore.getState().runId).toBe('');
  expect(useWorkbenchStore.getState().submitError).toBe('');
  expect(useWorkbenchStore.getState().form.lotCount).toBe('12');

  // Server snapshots stay in TanStack Query and the submission lifecycle (pending
  // idempotency key, in-flight request) stays in controllers/use-run-submission;
  // the store never mirrors either.
  expect(useWorkbenchStore.getState()).not.toHaveProperty('pendingSubmission');
  expect(workbenchActions).not.toHaveProperty('submissionPrepared');
  expect(workbenchActions).not.toHaveProperty('submissionCompleted');
});

it('drops the unused tour countdown branch from the Twin page store (section 6.3)', () => {
  // No src/tests consumer reads this state; the tour HUD uses its own timeline.
  expect(useTwinPageStore.getState()).not.toHaveProperty('tourRemainingMs');
  expect(twinPageActions).not.toHaveProperty('tourRemainingSet');
  expect(twinPageActions).not.toHaveProperty('tourTick');
});

it('has a single language/theme authority shared by catalog and Twin', () => {
  localeActions.preferencesSet({ language: 'en', theme: 'dark' });
  localeActions.themeToggled();
  expect(useLocaleStore.getState()).toEqual({ language: 'en', theme: 'light' });
  expect(useCatalogStore.getState()).not.toHaveProperty('preferences');
});
