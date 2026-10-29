import { Schema } from 'effect';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunRequestSchema, runSummarySchema, runResultSchema } from '@/api/runs.schema';
import { catalogPageSchema } from '@/api/catalog.schema';
import { catalogQueryOptions } from '@/api/catalog.resource';

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
  expect(Schema.decodeUnknownSync(runSummarySchema)(run)).toEqual(run);
  expect(() => Schema.decodeUnknownSync(runSummarySchema)({ ...run, executions: [{ fabId: 'fab-1' }] })).toThrow();
  expect(() => Schema.decodeUnknownSync(runSummarySchema)({ ...run, executions: [null] })).toThrow();
});

it('validates nested run results and every simulation event', () => {
  const result = { runId: 'run-1', fabs: [{
    fabId: 'fab-1', completedLots: '1', totalLots: '1', simulationTimeUs: '12',
    busyTimeUs: '10', traceHash: 'sha', events: [{
      fabId: 'fab-1', entityId: 'carrier-1', kind: 'ARRIVED', simulationTimeUs: '10', sequence: '1',
    }],
  }] };
  expect(Schema.decodeUnknownSync(runResultSchema)(result)).toEqual(result);
  expect(() => Schema.decodeUnknownSync(runResultSchema)({ ...result, fabs: [{ ...result.fabs[0], events: [{}] }] })).toThrow();
});

it('checks catalog metadata and raw identity consistency before accepting a page', () => {
  expect(Schema.decodeUnknownSync(catalogPageSchema)(page).items).toHaveLength(1);
  expect(() => Schema.decodeUnknownSync(catalogPageSchema)({ ...page, items: [{ ...entry, vendor: 'Changed' }] })).toThrow();
  expect(() => Schema.decodeUnknownSync(catalogPageSchema)({ ...page, items: [entry, entry], matchedCount: 2, totalCount: 2 })).toThrow();
  expect(() => Schema.decodeUnknownSync(catalogPageSchema)({ ...page, items: [{ ...entry, record: null }] })).toThrow();
  expect(() => Schema.decodeUnknownSync(catalogPageSchema)({ ...page, items: [{ ...entry, completenessPct: 101 }] })).toThrow();
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

it('validates run submissions before sending HTTP', () => {
  const valid = { scenario: { contractVersion: 1, siteId: '3acd7b05-e6e8-5312-bb5b-045e7dd3074b', mode: 'INDEPENDENT',
    masterSeed: '42', durationUs: '1000', warmupUs: '0',
    fabs: [{ fabId: 'e3021724-ec73-534e-be7c-ba3374f4ddb8', code: 'FAB-1', lotCount: 1, processTimeUs: '100' }] } };
  expect(Schema.decodeUnknownSync(createRunRequestSchema)(valid)).toEqual(valid);
  expect(() => Schema.decodeUnknownSync(createRunRequestSchema)({ ...valid, scenario: { ...valid.scenario,
    fabs: [{ ...valid.scenario.fabs[0], lotCount: -1 }] } })).toThrow();
  expect(() => Schema.decodeUnknownSync(createRunRequestSchema)({ ...valid, scenario: { ...valid.scenario,
    fabs: [{ ...valid.scenario.fabs[0], processTimeUs: 'invalid' }] } })).toThrow();
  expect(() => Schema.decodeUnknownSync(createRunRequestSchema)({ ...valid, scenario: { ...valid.scenario,
    warmupUs: 'broken' } })).toThrow();
  expect(() => Schema.decodeUnknownSync(createRunRequestSchema)({ ...valid, scenario: { ...valid.scenario,
    warmupUs: '1000' } })).toThrow();
});

it('retains the catalog UUID version and variant acceptance policy', () => {
  const withId = (recordId: string) => ({ ...page, items: [{ ...entry, recordId,
    record: { ...entry.record, record_id: recordId } }] });
  for (const id of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', uuid.toUpperCase()])
    expect(() => Schema.decodeUnknownSync(catalogPageSchema)(withId(id))).not.toThrow();
  for (const id of ['FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', '3acd7b05-e6e8-9312-bb5b-045e7dd3074b', '3acd7b05-e6e8-5312-7b5b-045e7dd3074b'])
    expect(() => Schema.decodeUnknownSync(catalogPageSchema)(withId(id))).toThrow();
});
