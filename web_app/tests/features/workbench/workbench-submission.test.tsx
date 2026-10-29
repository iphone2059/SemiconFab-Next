// @vitest-environment jsdom
import { resetWorkbenchState } from '../../../tests/support/reset-ui-atoms';
import { useAtomValue } from '@effect/atom-react';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
import { Effect } from 'effect';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunSummary, SiteDto } from '@/contracts/app-contracts';
import { useRunSubmission } from '@/workbench/use-run-submission';
import {
  workbenchAtom,
  workbenchActions,
} from '@/workbench/workbench.atom';
import { createTestRuntime, ResourceTestProviders } from '../../support/resource-test-runtime.tsx';

// The HTTP boundary is mocked so each case controls when a submission resolves.
const { registry, render } = createAtomTestScope();
const api = vi.hoisted(() => ({ createRun: vi.fn(), invalidateRuns: vi.fn() }));
vi.mock('@/api/runs.mutation', () => ({
  createRun: api.createRun,
  invalidateRuns: api.invalidateRuns,
}));

const site = (siteId: string): SiteDto => ({
  siteId,
  code: siteId.toUpperCase(),
  templateHash: 'hash',
  fabs: [{ fabId: 'product-fab', code: 'FAB' }],
});

const run = (runId: string, siteId = 'site-a'): RunSummary => ({
  runId,
  siteId,
  status: 'QUEUED',
  version: '1',
  createdAtUtc: '2026-10-27T00:00:00Z',
  executions: [],
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Mirrors the page wiring: form draft from the store, command submit from the controller. */
function Harness({ target }: { target: SiteDto }) {
  const form = useAtomValue(workbenchAtom, (state) => state.form);
  const submitError = useAtomValue(workbenchAtom, (state) => state.submitError);
  const { submit, submitting } = useRunSubmission(target, form);
  return (
    <form onSubmit={(event) => { void submit(event); }}>
      {submitError && <div role="alert">{submitError}</div>}
      <button disabled={submitting}>run</button>
    </form>
  );
}

function renderHarness(target: SiteDto) {
  const queryClient = createTestRuntime(registry);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ResourceTestProviders, { runtime: queryClient, children });
  const tree = (next: SiteDto) => createElement(wrapper, null, createElement(Harness, { target: next }));
  const view = render(tree(target));
  return {
    rerender: (next: SiteDto) => view.rerender(tree(next)),
    form: () => view.container.querySelector('form') as HTMLFormElement,
    alert: () => view.container.querySelector('[role="alert"]')?.textContent ?? '',
    view,
  };
}

beforeEach(() => {
  resetWorkbenchState(registry);
  api.createRun.mockReset();
  api.invalidateRuns.mockReset();
  let nextId = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `idem-${++nextId}` });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('reuses the idempotency key only for an unchanged retry scenario', async () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  api.createRun.mockReturnValue(Effect.fail(new Error('submit failed')));
  const harness = renderHarness(site('site-a'));

  fireEvent.submit(harness.form());
  await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(harness.alert()).toContain('submit failed'));

  fireEvent.submit(harness.form());
  await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));
  const keys = api.createRun.mock.calls.map(
    (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
  );
  expect(keys[1]).toBe(keys[0]);

  // A different scenario is a new logical command: mint a new key.
  act(() => workbenchActions.formFieldSet(registry, { field: 'lotCount', value: '25' }));
  fireEvent.submit(harness.form());
  await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(3));
  const changed = api.createRun.mock.calls[2][0] as { idempotencyKey: string };
  expect(changed.idempotencyKey).not.toBe(keys[0]);
});

it('applies a completion only while the submitted site is still active', async () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  const pending = deferred<RunSummary>();
  api.createRun.mockReturnValueOnce(Effect.promise(() => pending.promise));
  const harness = renderHarness(site('site-a'));
  fireEvent.submit(harness.form());
  await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));

  // Site switch before the request settles: the site-A completion must not
  // select a run on site B or write any other state.
  act(() => workbenchActions.siteIdSet(registry, 'site-b'));
  harness.rerender(site('site-b'));
  await act(async () => {
    pending.resolve(run('run-a'));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(registry.get(workbenchAtom).runId).toBe('');
  expect(registry.get(workbenchAtom).submitError).toBe('');
  expect(harness.alert()).toBe('');
});

it('drops a completion whose submitting component unmounted', async () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  const pending = deferred<RunSummary>();
  api.createRun.mockReturnValueOnce(Effect.promise(() => pending.promise));
  const harness = renderHarness(site('site-a'));
  fireEvent.submit(harness.form());
  await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));

  harness.view.unmount();
  await act(async () => {
    pending.resolve(run('run-a'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(registry.get(workbenchAtom).runId).toBe('');
});

it('selects the created run after an accepted submission for the active site', async () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  api.createRun.mockReturnValueOnce(Effect.succeed(run('run-accepted')));
  const harness = renderHarness(site('site-a'));
  fireEvent.submit(harness.form());

  await waitFor(() => expect(registry.get(workbenchAtom).runId).toBe('run-accepted'));
  expect(registry.get(workbenchAtom).submitError).toBe('');
  expect(api.createRun).toHaveBeenCalledTimes(1);
  const input = api.createRun.mock.calls[0][0] as {
    request: { scenario: { siteId: string; fabs: unknown[] } };
    idempotencyKey: string;
  };
  expect(input.request.scenario.siteId).toBe('site-a');
  expect(input.request.scenario.fabs).toHaveLength(1);
  expect(input.idempotencyKey).toBe('idem-1');
});
