// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
