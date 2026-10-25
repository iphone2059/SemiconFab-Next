import { configureStore } from '@reduxjs/toolkit';
import { expect, it } from 'vitest';
import { workbenchActions, workbenchSlice } from '../src/store/workbenchSlice';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import WorkbenchApp from '../src/workbench';
import { store as appStore } from '../src/store/store';
import { twinApi } from '../src/store/api';

const createStore = () => configureStore({ reducer: workbenchSlice.reducer });

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

it('does not render cached run details or totals belonging to another site', async () => {
  appStore.dispatch(workbenchActions.siteIdSet('site-b'));
  appStore.dispatch(workbenchActions.runIdSet('a-run'));
  await appStore.dispatch(twinApi.util.upsertQueryData('getSites', undefined, [{
    siteId: 'site-b', code: 'B', templateHash: 'hash', fabs: [{ fabId: 'b-fab', code: 'FAB-B' }],
  }]));
  await appStore.dispatch(twinApi.util.upsertQueryData('getRuns', undefined, []));
  await appStore.dispatch(twinApi.util.upsertQueryData('getRun', 'a-run', {
    runId: 'a-run', siteId: 'site-a', status: 'COMPLETED', version: '1',
    createdAtUtc: '2026-10-25T00:00:00Z', executions: [],
  }));
  await appStore.dispatch(twinApi.util.upsertQueryData('getRunResults', 'a-run', {
    runId: 'a-run', fabs: [{ fabId: 'a-fab', completedLots: '999999', totalLots: '999999',
      simulationTimeUs: '1', busyTimeUs: '1', traceHash: 'hash', events: [] }],
  }));
  const html = renderToStaticMarkup(createElement(Provider, { store: appStore, children: createElement(WorkbenchApp) }));
  expect(html).toContain('AWAITING RUN');
  expect(html).not.toContain('999,999');
  appStore.dispatch(twinApi.util.resetApiState());
});
