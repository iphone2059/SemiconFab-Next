import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { runSummarySchema, runResultSchema } from '../../src/api/schemas/runs.schema';
import { catalogPageSchema } from '../../src/api/schemas/catalog.schema';
import { catalogQueryOptions } from '../../src/api/queries/catalog.queries';

const uuid = '3acd7b05-e6e8-5312-bb5b-045e7dd3074b';
const entry = {
  recordId: uuid, vendor: 'Canon', model: 'FPA', category: 'lithography',
  domain: 'FAB', conformanceLevel: 'draft', completenessPct: 50,
  missingFields: [], price: null, legacy: {},
  record: { record_id: uuid, identity: {
    vendor: { value: 'Canon' }, model: { value: 'FPA' }, category: { value: 'lithography' },
  } },
};
const page = {
  importId: 'import-1', totalCount: 1, matchedCount: 1,
  categories: [{ domain: 'FAB', category: 'lithography', count: 1 }],
  items: [entry],
};
const run = {
  runId: 'run-1', siteId: 'site-1', status: 'QUEUED', version: '1',
  createdAtUtc: '2026-10-28T00:00:00Z',
  executions: [{
    fabId: 'fab-1', code: 'FAB-1', status: 'QUEUED', completedLots: '0',
    totalLots: '100', simulationTimeUs: '0', traceHash: null, error: null,
  }],
};

afterEach(() => vi.unstubAllGlobals());

it('validates every nested run summary, not only the parent envelope', () => {
  expect(runSummarySchema.parse(run)).toEqual(run);
  expect(() => runSummarySchema.parse({ ...run, executions: [{ fabId: 'fab-1' }] })).toThrow();
  expect(() => runSummarySchema.parse({ ...run, executions: [null] })).toThrow();
});

it('validates nested run results and every simulation event', () => {
  const result = { runId: 'run-1', fabs: [{
    fabId: 'fab-1', completedLots: '1', totalLots: '1', simulationTimeUs: '12',
    busyTimeUs: '10', traceHash: 'sha', events: [{
      fabId: 'fab-1', entityId: 'carrier-1', kind: 'ARRIVED', simulationTimeUs: '10', sequence: '1',
    }],
  }] };
  expect(runResultSchema.parse(result)).toEqual(result);
  expect(() => runResultSchema.parse({ ...result, fabs: [{ ...result.fabs[0], events: [{}] }] })).toThrow();
});

it('checks catalog metadata and raw identity consistency before accepting a page', () => {
  expect(catalogPageSchema.parse(page).items).toHaveLength(1);
  expect(() => catalogPageSchema.parse({ ...page, items: [{ ...entry, vendor: 'Changed' }] })).toThrow();
  expect(() => catalogPageSchema.parse({ ...page, items: [entry, entry], matchedCount: 2, totalCount: 2 })).toThrow();
  expect(() => catalogPageSchema.parse({ ...page, items: [{ ...entry, record: null }] })).toThrow();
  expect(() => catalogPageSchema.parse({ ...page, items: [{ ...entry, completenessPct: 101 }] })).toThrow();
});

it('never caches a malformed catalog payload from the server', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ...page, items: [{ ...entry, recordId: 'invalid' }],
  }), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await expect(client.fetchQuery(catalogQueryOptions())).rejects.toThrow();
  expect(client.getQueryData(catalogQueryOptions().queryKey)).toBeUndefined();
  client.clear();
});
