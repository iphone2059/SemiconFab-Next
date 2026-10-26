import { configureStore } from '@reduxjs/toolkit';
import { expect, it } from 'vitest';
import { workbenchActions, workbenchSlice } from '../src/store/workbenchSlice';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkbenchApp from '../src/workbench';
import { sitesQueryOptions } from '../src/api/queries/sites.queries';
import { runQueryOptions, runResultsQueryOptions, runsQueryOptions } from '../src/api/queries/runs.queries';
import { store as appStore } from '../src/store/store';

const createStore = () => configureStore({ reducer: workbenchSlice.reducer });
// Server state for sites/runs/run/results is owned by TanStack Query (ARCH G-02);
// every test that renders gets its own isolated Query cache.
const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

it('keeps a newly created or explicitly selected run while a stale list refreshes', () => {
  const store = createStore();
  store.dispatch(workbenchActions.siteIdSet('site-a'));
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['old-run'] }));
  expect(store.getState().runId).toBe('old-run');
  store.dispatch(workbenchActions.runIdSet('new-run'));
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['old-run'] }));
  expect(store.getState().runId).toBe('new-run');
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['new-run', 'old-run'] }));
  store.dispatch(workbenchActions.runIdSet('old-run'));
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['new-run', 'old-run'] }));
  expect(store.getState().runId).toBe('old-run');
});

it('clears the previous site selection and rejects its late list when the new site is empty', () => {
  const store = createStore();
  store.dispatch(workbenchActions.siteIdSet('site-a'));
  store.dispatch(workbenchActions.runIdSet('a-run'));
  store.dispatch(workbenchActions.siteIdSet('site-a'));
  expect(store.getState().runId).toBe('a-run');
  store.dispatch(workbenchActions.siteIdSet('site-b'));
  expect(store.getState().runId).toBe('');
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-a', runIds: ['a-run'] }));
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-b', runIds: [] }));
  expect(store.getState().runId).toBe('');
  store.dispatch(workbenchActions.runsReceived({ siteId: 'site-b', runIds: ['b-run'] }));
  expect(store.getState().runId).toBe('b-run');
});

it('does not render cached run details or totals belonging to another site', () => {
  appStore.dispatch(workbenchActions.siteIdSet('site-b'));
  appStore.dispatch(workbenchActions.runIdSet('a-run'));
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
  const html = renderToStaticMarkup(createElement(Provider, { store: appStore, children: createElement(QueryClientProvider, { client: queryClient, children: createElement(WorkbenchApp) }) }));
  expect(html).toContain('AWAITING RUN');
  expect(html).not.toContain('999,999');
});
