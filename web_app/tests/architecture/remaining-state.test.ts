import { resetCatalogState, resetLocaleState, resetRuntimeState, resetTwinPageState, resetTwinUiState, resetWorkbenchState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { beforeEach, expect, it } from 'vitest';
import { viewerActions, viewerHoverAtom, viewerSessionAtom } from '@/state/viewer.atom';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';
import { twinPageUiActions, twinPageUiAtom } from '@/twin/twin-page-ui.atom';
import { twinWaferActions, twinWaferAtom } from '@/twin/twin-wafer.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';
import { workbenchAtom, workbenchActions } from '@/workbench/workbench.atom';
import { localeActions, localeAtom } from '@/state/locale.atom';
import type { WaferHud } from '@/domain/wafer-timeline';

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
  viewerActions.viewerMounted(registry, 'old');
  viewerActions.viewerMounted(registry, 'current');
  viewerActions.viewerLifecycleReceived(registry, { epoch: 'old', event: { type: 'failed', message: 'obsolete error', error: new Error('obsolete error') } });
  expect(registry.get(viewerSessionAtom).status).not.toBe('obsolete error');
  expect(registry.get(viewerSessionAtom).lifecycle).toBe('initializing');
  viewerActions.viewerLifecycleReceived(registry, { epoch: 'current', event: { type: 'ready', message: 'WebGPU · ready' } });
  expect(registry.get(viewerSessionAtom).lifecycle).toBe('ready');
  viewerActions.viewerReloadRequested(registry);
  viewerActions.viewerLifecycleReceived(registry, { epoch: 'current', event: { type: 'ready', message: 'WebGPU · stale' } });
  expect(registry.get(viewerSessionAtom).generation).toBe(1);
  expect(registry.get(viewerSessionAtom).status).not.toContain('stale');
  expect(registry.get(viewerSessionAtom).lifecycle).toBe('idle');
  expect(registry.get(viewerHoverAtom)).toBeUndefined();
  // The lifecycle enum, not the display text, owns the control state after unmount. The
  // reload cleared the epoch first, so the stale unmount of the replaced viewer is ignored.
  viewerActions.viewerUnmounted(registry, 'current');
  expect(registry.get(viewerSessionAtom).lifecycle).toBe('idle');
  viewerActions.viewerMounted(registry, 'next');
  viewerActions.viewerUnmounted(registry, 'next');
  expect(registry.get(viewerSessionAtom).lifecycle).toBe('disposed');
  expect(registry.get(viewerSessionAtom).status).not.toBe('WebGPU · stale');
});

it('keeps the Wafer process projection separate from Twin presentation state', () => {
  const hud: WaferHud = {
    step: 'Step 1/104', width: '1.0%', toolGroup: 'TG02_TRACK', recipe: 'REC',
    bay: 'Track Bay', status: 'Navigating...', badge: 'Product B · 104 Steps',
  };
  twinWaferActions.projectionSet(registry, {
    active: true, playing: true, speed: 16, product: 'B', index: 0, completed: false,
  });
  twinWaferActions.hudSet(registry, hud);
  expect(registry.get(twinWaferAtom)).toMatchObject({
    active: true, playing: true, speed: 16, product: 'B', index: 0, hud,
  });
  expect(registry.get(twinUiAtom)).not.toHaveProperty('wafer');
  twinWaferActions.projectionSet(registry, {
    active: false, playing: false, speed: 16, product: 'B', index: 0, completed: false,
  });
  twinWaferActions.hudClear(registry);
  expect(registry.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, hud: undefined, completed: false });
  expect(() => JSON.stringify(registry.get(twinWaferAtom))).not.toThrow();
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

it('drops the unused tour countdown branch from every Twin page atom (section 6.3)', () => {
  // No src/tests consumer reads this state; the tour HUD uses its own timeline.
  expect(registry.get(twinPageAtom)).not.toHaveProperty('tourRemainingMs');
  expect(registry.get(twinPageUiAtom)).not.toHaveProperty('tourRemainingMs');
  expect(twinPageActions).not.toHaveProperty('tourRemainingSet');
  expect(twinPageUiActions).not.toHaveProperty('tourRemainingSet');
  expect(twinPageActions).not.toHaveProperty('tourTick');
  expect(twinPageUiActions).not.toHaveProperty('tourTick');
});

it('has a single language/theme authority shared by catalog and Twin', () => {
  localeActions.preferencesSet(registry, { language: 'en', theme: 'dark' });
  localeActions.themeToggled(registry);
  expect(registry.get(localeAtom)).toEqual({ language: 'en', theme: 'light' });
  expect(registry.get(catalogAtom)).not.toHaveProperty('preferences');
});
