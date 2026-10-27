// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkbenchApp from '../src/features/workbench/workbench';
import { sitesQueryOptions } from '../src/api/queries/sites.queries';
import { runQueryOptions, runResultsQueryOptions, runsQueryOptions } from '../src/api/queries/runs.queries';
import {
  resetWorkbenchStore,
  useWorkbenchStore,
  workbenchActions,
} from '../src/state/workbenchStore';

// Server state for sites/runs/run/results is owned by TanStack Query (ARCH G-02);
// every test that renders gets its own isolated Query cache. Client UI state lives
// in the Zustand workbench store and is reset between cases.
const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => resetWorkbenchStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps a newly created or explicitly selected run while a stale list refreshes', () => {
  workbenchActions.siteIdSet('site-a');
  workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['old-run'] });
  expect(useWorkbenchStore.getState().runId).toBe('old-run');
  workbenchActions.runIdSet('new-run');
  workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['old-run'] });
  expect(useWorkbenchStore.getState().runId).toBe('new-run');
  workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['new-run', 'old-run'] });
  workbenchActions.runIdSet('old-run');
  workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['new-run', 'old-run'] });
  expect(useWorkbenchStore.getState().runId).toBe('old-run');
});

it('clears the previous site selection and rejects its late list when the new site is empty', () => {
  workbenchActions.siteIdSet('site-a');
  workbenchActions.runIdSet('a-run');
  workbenchActions.siteIdSet('site-a');
  expect(useWorkbenchStore.getState().runId).toBe('a-run');
  workbenchActions.siteIdSet('site-b');
  expect(useWorkbenchStore.getState().runId).toBe('');
  workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['a-run'] });
  workbenchActions.runsReceived({ siteId: 'site-b', runIds: [] });
  expect(useWorkbenchStore.getState().runId).toBe('');
  workbenchActions.runsReceived({ siteId: 'site-b', runIds: ['b-run'] });
  expect(useWorkbenchStore.getState().runId).toBe('b-run');
});

it('does not render cached run details or totals belonging to another site', () => {
  workbenchActions.siteIdSet('site-b');
  workbenchActions.runIdSet('a-run');
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

it('renders one execution card and selector option per site FAB (data-driven multi-FAB)', () => {
  workbenchActions.siteIdSet('site-m');
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v1/runs')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return new Promise(() => {});
  }));
  const queryClient = createQueryClient();
  queryClient.setQueryData(sitesQueryOptions().queryKey, [{
  siteId: 'site-m', code: 'MULTI', templateHash: 'hash',
  fabs: [{ fabId: 'fab-a', code: 'FAB-A' }, { fabId: 'fab-b', code: 'FAB-B' }, { fabId: 'fab-c', code: 'FAB-C' }],
}]);
  queryClient.setQueryData(runsQueryOptions().queryKey, []);
  const { container } = render(
    createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
  );
  expect(container.querySelectorAll('aside select option')).toHaveLength(3);
  expect(container.querySelectorAll('.fab-card')).toHaveLength(3);
  // The FAB metric is the catalog length, not a hard-coded single FAB.
  expect(container.querySelector('.metric strong')?.textContent).toBe('03');
  for (const code of ['FAB-A', 'FAB-B', 'FAB-C']) expect(container.innerHTML).toContain(code);
  expect(container.innerHTML).not.toContain('单 FAB 执行域');
});

it('submits one scenario FAB per site FAB', async () => {
  workbenchActions.siteIdSet('site-m');
  const bodies: Array<{ scenario: { fabs: unknown[] } }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/runs') && init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)) as { scenario: { fabs: unknown[] } });
      return new Response(JSON.stringify({
        runId: 'run-9', siteId: 'site-m', status: 'QUEUED', version: '1',
        createdAtUtc: '2026-10-27T00:00:00Z', executions: [],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/v1/runs')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Promise(() => {});
  }));
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: { ...originalCrypto, randomUUID: () => 'idem-multi' }, configurable: true });
  try {
    const queryClient = createQueryClient();
    queryClient.setQueryData(sitesQueryOptions().queryKey, [{
  siteId: 'site-m', code: 'MULTI', templateHash: 'hash',
  fabs: [{ fabId: 'fab-a', code: 'FAB-A' }, { fabId: 'fab-b', code: 'FAB-B' }, { fabId: 'fab-c', code: 'FAB-C' }],
}]);
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
      { fabId: 'fab-a', code: 'FAB-A', lotCount: 24, processTimeUs: '1000000' },
      { fabId: 'fab-b', code: 'FAB-B', lotCount: 24, processTimeUs: '1000000' },
      { fabId: 'fab-c', code: 'FAB-C', lotCount: 24, processTimeUs: '1000000' },
    ]);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
  }
});

it('remounts the command console when the selected FAB changes so console state cannot cross FABs', () => {
  workbenchActions.siteIdSet('site-m');
  // Background queries stay pending; only the console markup matters here.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const queryClient = createQueryClient();
  queryClient.setQueryData(sitesQueryOptions().queryKey, [{
    siteId: 'site-m', code: 'MULTI', templateHash: 'hash',
    fabs: [{ fabId: 'fab-a', code: 'FAB-A' }, { fabId: 'fab-b', code: 'FAB-B' }],
  }]);
  queryClient.setQueryData(runsQueryOptions().queryKey, []);
  const { container } = render(
    createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }),
  );
  const fabSelect = container.querySelector('.sidebar-note select') as HTMLSelectElement | null;
  expect(fabSelect).not.toBeNull();
  const consoleSelects = () => container.querySelectorAll('form select');
  const firstEquipment = consoleSelects()[0] as HTMLSelectElement;
  expect(firstEquipment.value).toBe('equipment-0');
  fireEvent.change(firstEquipment, { target: { value: 'equipment-5' } });
  expect((consoleSelects()[0] as HTMLSelectElement).value).toBe('equipment-5');

  fireEvent.change(fabSelect as HTMLSelectElement, { target: { value: '1' } });

  // The FAB switch replaces the scope-keyed console instance, so no form state
  // (and, in the component, no history/key/busy/error) crosses to FAB-B.
  const secondEquipment = consoleSelects()[0] as HTMLSelectElement;
  expect(secondEquipment).not.toBe(firstEquipment);
  expect(secondEquipment.value).toBe('equipment-0');
});
