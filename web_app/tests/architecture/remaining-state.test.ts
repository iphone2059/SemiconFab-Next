import { resetCatalogState, resetLocaleState, resetRuntimeState, resetTwinPageState, resetTwinUiState, resetWorkbenchState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { beforeEach, expect, it } from 'vitest';
import { runtimeActions, runtimeAtom } from '@/state/runtime-store';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';
import { twinUiActions, twinUiAtom } from '@/twin/twin-ui.atom';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';
import { workbenchAtom, workbenchActions } from '@/workbench/workbench.atom';
import { localeActions, localeAtom } from '@/state/locale.atom';
import { createWaferTimeline } from '@/domain/wafer-timeline';
import { buildWaferScenario } from '@/domain/wafer-scenario';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { closeWaferSession } from '@/twin/twin-wafer-session';
import { readFileSync } from 'node:fs';

const { registry } = createAtomTestScope();
beforeEach(() => {
  resetRuntimeState(registry);
  resetTwinPageState(registry);
  resetTwinUiState(registry);
  resetCatalogState(registry);
  resetWorkbenchState(registry);
  resetLocaleState(registry);
});

it('owns viewer lifecycle and hover in the runtime store and ignores callbacks from replaced scenes', () => {
  runtimeActions.viewerMounted(registry, 'old');
  runtimeActions.viewerMounted(registry, 'current');
  runtimeActions.viewerLifecycleReceived(registry, { epoch: 'old', event: { type: 'failed', message: 'obsolete error', error: new Error('obsolete error') } });
  expect(registry.get(runtimeAtom).viewer.status).not.toBe('obsolete error');
  expect(registry.get(runtimeAtom).viewer.lifecycle).toBe('initializing');
  runtimeActions.viewerLifecycleReceived(registry, { epoch: 'current', event: { type: 'ready', message: 'WebGPU · ready' } });
  expect(registry.get(runtimeAtom).viewer.lifecycle).toBe('ready');
  runtimeActions.viewerReloadRequested(registry);
  runtimeActions.viewerLifecycleReceived(registry, { epoch: 'current', event: { type: 'ready', message: 'WebGPU · stale' } });
  expect(registry.get(runtimeAtom).viewer.generation).toBe(1);
  expect(registry.get(runtimeAtom).viewer.status).not.toContain('stale');
  expect(registry.get(runtimeAtom).viewer.lifecycle).toBe('idle');
  expect(registry.get(runtimeAtom).viewer.hover).toBeUndefined();
  // The lifecycle enum, not the display text, owns the control state after unmount. The
  // reload cleared the epoch first, so the stale unmount of the replaced viewer is ignored.
  runtimeActions.viewerUnmounted(registry, 'current');
  expect(registry.get(runtimeAtom).viewer.lifecycle).toBe('idle');
  runtimeActions.viewerMounted(registry, 'next');
  runtimeActions.viewerUnmounted(registry, 'next');
  expect(registry.get(runtimeAtom).viewer.lifecycle).toBe('disposed');
  expect(registry.get(runtimeAtom).viewer.status).not.toBe('WebGPU · stale');
});

it('projects controller HUD into the page store and closes the coordinated wafer session explicitly', () => {
  const routes = parseWaferRoutes(JSON.parse(readFileSync(new URL('../../public/twin/routes.json', import.meta.url), 'utf8')));
  const timeline = createWaferTimeline(buildWaferScenario(routes, 'en'));
  timeline.setProduct('B');
  const frame = timeline.readFrame();
  twinUiActions.waferOpen(registry);
  twinPageActions.waferFrameReceived(registry, { product: 'B', index: frame.index, hud: frame.hud, completed: true });
  expect(registry.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 0, hud: { step: 'Step 1/104', status: 'Navigating...' } });
  expect(registry.get(twinUiAtom).wafer).toMatchObject({ active: true, playing: true });

  // The Twin UI store owns close/playback only. Closing it must never mutate the
  // page store through a hidden cross-store call.
  twinUiActions.waferClose(registry);
  expect(registry.get(twinUiAtom).wafer).toMatchObject({ active: false, playing: false });
  expect(registry.get(twinPageAtom).wafer.hud).toBeDefined();
  expect(registry.get(twinPageAtom).wafer.completed).toBe(true);

  // The application-level use case coordinates both stores; the scene cleanup
  // stays with the wafer playback controller/page caller.
  closeWaferSession(registry);
  expect(registry.get(twinPageAtom).wafer.hud).toBeUndefined();
  expect(registry.get(twinPageAtom).wafer.completed).toBe(false);
  expect(registry.get(twinUiAtom).wafer).toMatchObject({ active: false, playing: false });
  expect(() => JSON.stringify(registry.get(twinPageAtom))).not.toThrow();
});

it('invalidates an in-flight local import when returning to server data', () => {
  catalogActions.importStarted(registry, 'import-a');
  catalogActions.importFailed(registry, { requestId: 'import-a', error: 'invalid JSON' });
  catalogActions.localImportCleared(registry);
  catalogActions.localImportApplied(registry, { requestId: 'import-a', entries: [], importId: 'stale.json' });
  expect(registry.get(catalogAtom).localEntries).toBeNull();
  expect(registry.get(catalogAtom).importError).toBe('');
  expect(registry.get(catalogAtom).importPending).toBe(false);
});

it('keeps only client UI state in the Workbench store (no parallel server/command cache)', () => {
  workbenchActions.siteIdSet(registry, 'a');
  workbenchActions.runIdSet(registry, 'a-run');
  workbenchActions.formFieldSet(registry, { field: 'lotCount', value: '12' });
  workbenchActions.submitErrorSet(registry, 'submit failed');

  // A site switch clears the server-run selection and transient error, but keeps
  // the local form draft (the user may retarget the run).
  workbenchActions.siteIdSet(registry, 'b');
  expect(registry.get(workbenchAtom).runId).toBe('');
  expect(registry.get(workbenchAtom).submitError).toBe('');
  expect(registry.get(workbenchAtom).form.lotCount).toBe('12');

  // Server snapshots stay in TanStack Query and the submission lifecycle (pending
  // idempotency key, in-flight request) stays in controllers/use-run-submission;
  // the store never mirrors either.
  expect(registry.get(workbenchAtom)).not.toHaveProperty('pendingSubmission');
  expect(workbenchActions).not.toHaveProperty('submissionPrepared');
  expect(workbenchActions).not.toHaveProperty('submissionCompleted');
});

it('drops the unused tour countdown branch from the Twin page store (section 6.3)', () => {
  // No src/tests consumer reads this state; the tour HUD uses its own timeline.
  expect(registry.get(twinPageAtom)).not.toHaveProperty('tourRemainingMs');
  expect(twinPageActions).not.toHaveProperty('tourRemainingSet');
  expect(twinPageActions).not.toHaveProperty('tourTick');
});

it('has a single language/theme authority shared by catalog and Twin', () => {
  localeActions.preferencesSet(registry, { language: 'en', theme: 'dark' });
  localeActions.themeToggled(registry);
  expect(registry.get(localeAtom)).toEqual({ language: 'en', theme: 'light' });
  expect(registry.get(catalogAtom)).not.toHaveProperty('preferences');
});
