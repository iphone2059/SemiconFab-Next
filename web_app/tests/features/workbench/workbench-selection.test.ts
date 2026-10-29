// @vitest-environment jsdom
import { resetWorkbenchState } from '../../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkbenchApp from '@/workbench/workbench';
import { sitesQueryOptions } from '@/api/sites.resource';
import { runQueryOptions, runResultsQueryOptions, runsQueryOptions } from '@/api/runs.resource';
import {
  workbenchAtom,
  workbenchActions,
} from '@/workbench/workbench.atom';

// Server state for sites/runs/run/results is owned by TanStack Query (ARCH G-02);
// every test that renders gets its own isolated Query cache. Client UI state lives
// in the Effect Atom workbench store and is reset between cases.
const { registry, render } = createAtomTestScope();
const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
// Use real wire identities: createRun validates Site/FAB GUIDs before HTTP.
const singleFabSite = {
  siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'DEMO-SITE', templateHash: 'hash',
  fabs: [{ fabId: '37793fb6-5679-b7a3-3fef-d970433697c1', code: 'FAB-01' }],
};

beforeEach(() => resetWorkbenchState(registry));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps a newly created or explicitly selected run while a stale list refreshes', () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  workbenchActions.runsReceived(registry, { siteId: 'site-a', runIds: ['old-run'] });
  expect(registry.get(workbenchAtom).runId).toBe('old-run');
  workbenchActions.runIdSet(registry, 'new-run');
  workbenchActions.runsReceived(registry, { siteId: 'site-a', runIds: ['old-run'] });
  expect(registry.get(workbenchAtom).runId).toBe('new-run');
  workbenchActions.runsReceived(registry, { siteId: 'site-a', runIds: ['new-run', 'old-run'] });
  workbenchActions.runIdSet(registry, 'old-run');
  workbenchActions.runsReceived(registry, { siteId: 'site-a', runIds: ['new-run', 'old-run'] });
  expect(registry.get(workbenchAtom).runId).toBe('old-run');
});

it('clears the previous site selection and rejects its late list when the new site is empty', () => {
  workbenchActions.siteIdSet(registry, 'site-a');
  workbenchActions.runIdSet(registry, 'a-run');
  workbenchActions.siteIdSet(registry, 'site-a');
  expect(registry.get(workbenchAtom).runId).toBe('a-run');
  workbenchActions.siteIdSet(registry, 'site-b');
  expect(registry.get(workbenchAtom).runId).toBe('');
  workbenchActions.runsReceived(registry, { siteId: 'site-a', runIds: ['a-run'] });
  workbenchActions.runsReceived(registry, { siteId: 'site-b', runIds: [] });
  expect(registry.get(workbenchAtom).runId).toBe('');
  workbenchActions.runsReceived(registry, { siteId: 'site-b', runIds: ['b-run'] });
  expect(registry.get(workbenchAtom).runId).toBe('b-run');
});

it('does not render cached run details or totals belonging to another site', () => {
  workbenchActions.siteIdSet(registry, 'site-b');
  workbenchActions.runIdSet(registry, 'a-run');
  // Keep background refetches pending instead of touching the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  // Seed the shared Query cache instead of the removed RTK cache.
  const queryClient = createQueryClient();
  queryClient.setQueryData(sitesQueryOptions().queryKey, [{
    siteId: 'site-b', code: 'B', templateHash: 'hash', fabs: [{ fabId: 'b-fab', code: 'FAB-B' }],
  }]);
  queryClient.setQueryData(runsQueryOptions().queryKey, []);
  queryClient.setQueryData(runQueryOptions('a-run').queryKey, {
    runId: 'a-run', siteId: 'site-a', status: 'COMPLETED', version: '1',
    createdAtUtc: '2026-10-25T00:00:00Z', executions: [],
  });
  queryClient.setQueryData(runResultsQueryOptions('a-run').queryKey, {
    runId: 'a-run', fabs: [{ fabId: 'a-fab', completedLots: '999999', totalLots: '999999',
      simulationTimeUs: '1', busyTimeUs: '1', traceHash: 'hash', events: [] }],
  });
  const { container } = render(
    createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
  );
  expect(container.innerHTML).toContain('AWAITING RUN');
  expect(container.innerHTML).not.toContain('999,999');
});

it('renders the single FAB execution card and metric without a redundant FAB selector', () => {
  workbenchActions.siteIdSet(registry, singleFabSite.siteId);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/runs')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return new Promise(() => {});
  }));
  const queryClient = createQueryClient();
  queryClient.setQueryData(sitesQueryOptions().queryKey, [singleFabSite]);
  queryClient.setQueryData(runsQueryOptions().queryKey, []);
  const { container } = render(
    createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
  );
  expect(container.querySelector('aside select')).toBeNull();
  expect(container.querySelectorAll('.fab-card')).toHaveLength(1);
  expect(container.querySelector('.metric strong')?.textContent).toBe('01');
  expect(container.querySelector('.fab-grid.single-fab')).not.toBeNull();
  expect(container.innerHTML).toContain('FAB-01');
});

it('submits the single FAB scenario through the validated HTTP boundary', async () => {
  workbenchActions.siteIdSet(registry, singleFabSite.siteId);
  const bodies: Array<{ scenario: { fabs: unknown[] } }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/runs') && init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)) as { scenario: { fabs: unknown[] } });
      return new Response(JSON.stringify({
        runId: 'run-9', siteId: singleFabSite.siteId, status: 'QUEUED', version: '1',
        createdAtUtc: '2026-10-27T00:00:00Z', executions: [],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/v1/runs')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Promise(() => {});
  }));
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: { ...originalCrypto, randomUUID: () => 'idem-single' }, configurable: true });
  try {
    const queryClient = createQueryClient();
    queryClient.setQueryData(sitesQueryOptions().queryKey, [singleFabSite]);
    queryClient.setQueryData(runsQueryOptions().queryKey, []);
    const { container } = render(
      createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
    );
    const form = container.querySelector('.workbench-run-form form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    await waitFor(() => expect(bodies).toHaveLength(1));
    // The generated contract keeps FabScenario.processTimeUs as a decimal string.
    expect(bodies[0].scenario.fabs).toEqual([
      { fabId: '37793fb6-5679-b7a3-3fef-d970433697c1', code: 'FAB-01', lotCount: 24, processTimeUs: '1000000' },
    ]);
    await waitFor(() => expect(registry.get(workbenchAtom).runId).toBe('run-9'));
    expect(registry.get(workbenchAtom).submitError).toBe('');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
  }
});

it('remounts the single FAB command console when its site scope changes', async () => {
  workbenchActions.siteIdSet(registry, singleFabSite.siteId);
  // Background queries stay pending; only the console markup matters here.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const queryClient = createQueryClient();
  queryClient.setQueryData(sitesQueryOptions().queryKey, [singleFabSite]);
  queryClient.setQueryData(runsQueryOptions().queryKey, []);
  const { container } = render(
    createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
  );
  expect(container.querySelector('.sidebar-note select')).toBeNull();
  const consoleSelects = () => container.querySelectorAll('form select');
  const firstEquipment = consoleSelects()[0] as HTMLSelectElement;
  expect(firstEquipment.value).toBe('equipment-0');
  fireEvent.change(firstEquipment, { target: { value: 'equipment-5' } });
  expect((consoleSelects()[0] as HTMLSelectElement).value).toBe('equipment-5');

  act(() => {
    queryClient.setQueryData(sitesQueryOptions().queryKey, [{
      ...singleFabSite, siteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', code: 'RELOADED',
    }]);
    workbenchActions.siteIdSet(registry, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  // Keep one active FAB while replacing the site's scope-keyed console instance.
  await waitFor(() => expect(consoleSelects()[0]).not.toBe(firstEquipment));
  const secondEquipment = consoleSelects()[0] as HTMLSelectElement;
  expect(secondEquipment).not.toBe(firstEquipment);
  expect(secondEquipment.value).toBe('equipment-0');
});
