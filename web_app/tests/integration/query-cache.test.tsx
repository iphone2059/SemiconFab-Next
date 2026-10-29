import { Effect } from 'effect';
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sitesQueryOptions } from '@/api/sites.resource';
import { equipmentStatusQueryOptions, equipmentStatusQueryKey } from '@/api/equipment.resource';
import { acceptEquipmentStatusSnapshot } from '@/api/equipment-status-bridge';
import { runsQueryOptions } from '@/api/runs.resource';
import { createRun as createRunEffect, invalidateRuns } from '@/api/runs.mutation';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';

/**
 * RQ-02/RQ-03/RQ-04 on the real TanStack Query modules (no RTK Query involved).
 * - RQ-02: a router loader keeps serving the cached value (ensureQueryData never
 *   forces a refetch), while the page subscription refetches on Query staleness.
 * - RQ-03: a mutation invalidates the runs prefix and the next read returns the
 *   authoritative server list.
 * - RQ-04: Query keys carry the (siteId, fabId) identity, and foreign identities
 *   cannot write the configured FAB's equipment-status cache entry.
 * - A02/A03: REST frames pass the same per-scope ordered acceptance gate as SSE;
 *   a rejected/delayed frame can never regress the FAB-scoped cache entry.
 */

const createRun = (...args: Parameters<typeof createRunEffect>) => Effect.runPromise(createRunEffect(...args));

const SITES_V1 = [{ siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-1', fabs: [{ fabId: 'FAB-01', code: 'FAB-01' }] }];
const SITES_V2 = [{ siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-2', fabs: [{ fabId: 'FAB-01', code: 'FAB-01' }] }];
const RUN_1 = { runId: 'run-1', siteId: 'site-1', status: 'RUNNING', version: '1', createdAtUtc: '2026-10-27T00:00:00Z', executions: [] };
const RUN_2 = { runId: 'run-2', siteId: 'site-1', status: 'QUEUED', version: '1', createdAtUtc: '2026-10-27T00:00:01Z', executions: [] };

/** A real FAB status frame carries one valid state per layout tool. */
const statusFrame = (siteId: string, fabId: string, sequence: number, generatedAt: string, state = 'running') => ({
  siteId,
  fabId,
  generatedAt,
  sequence,
  epoch: 1,
  tools: FAB_LAYOUT.map(() => ({ state })),
});
const STATUS_A = statusFrame('site-a', 'fab-1', 1, '2026-10-27T00:00:00Z');

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const freshClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

const wrapper = (queryClient: QueryClient) => {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

afterEach(() => vi.unstubAllGlobals());

it('RQ-02: loader serves cached data while the page subscription refetches stale Query data', async () => {
  let version = 1;
  const fetchMock = vi.fn(async () => jsonResponse(version === 1 ? SITES_V1 : SITES_V2));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();

  // Preload (router loader / hover preload path).
  const preloaded = await queryClient.ensureQueryData(sitesQueryOptions());
  expect(preloaded).toEqual(SITES_V1);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // Age the cache entry, then "navigate": the loader still returns the cached
  // value and does not force a request (ensureQueryData is not a refetch).
  queryClient.setQueryData(sitesQueryOptions().queryKey, preloaded, { updatedAt: Date.now() - 120_000 });
  const navigated = await queryClient.ensureQueryData(sitesQueryOptions());
  expect(navigated).toEqual(SITES_V1);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // The page subscription owns freshness: mounting the real useQuery hook sees a
  // stale entry and refetches in the background.
  version = 2;
  const { result } = renderHook(() => useQuery(sitesQueryOptions()), { wrapper: wrapper(queryClient) });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.data).toEqual(SITES_V2));
});

it('RQ-03: createRun invalidation refreshes the authoritative runs list', async () => {
  let runs = [RUN_1];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/runs') && init?.method === 'POST') {
      runs = [...runs, RUN_2];
      return jsonResponse(RUN_2);
    }
    if (url.endsWith('/api/v1/runs')) return jsonResponse(runs);
    throw new Error('unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();

  expect(await queryClient.ensureQueryData(runsQueryOptions())).toEqual([RUN_1]);
  const created = await createRun({ request: { scenario: {
    contractVersion: 1, siteId: '3acd7b05-e6e8-5312-bb5b-045e7dd3074b', mode: 'INDEPENDENT',
    masterSeed: '7', durationUs: '1000', warmupUs: '0',
    fabs: [{ fabId: 'e3021724-ec73-534e-be7c-ba3374f4ddb8', code: 'FAB-1', lotCount: 1, processTimeUs: '1' }],
  } }, idempotencyKey: 'idem-1' });
  expect(created).toEqual(RUN_2);
  await invalidateRuns(queryClient);
  // The next read (component refetch or explicit fetch) is authoritative.
  expect(await queryClient.fetchQuery(runsQueryOptions())).toEqual([RUN_1, RUN_2]);
  expect(fetchMock).toHaveBeenCalledTimes(3); // GET, POST, invalidated GET
});

it('RQ-04: the configured FAB cache rejects crossed FAB and site identities', async () => {
  const scope = { siteId: 'site-a', fabId: 'fab-1' };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/fabs/fab-1/')) return jsonResponse(STATUS_A);
    throw new Error('unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();
  // Both parts of the composite identity participate in the key. Foreign IDs
  // are rejection probes only; no second FAB is configured or fetched.
  expect(equipmentStatusQueryOptions('site-a', 'fab-1').queryKey)
    .not.toEqual(equipmentStatusQueryOptions('site-a', 'unknown-fab').queryKey);
  expect(equipmentStatusQueryOptions('site-a', 'fab-1').queryKey)
    .not.toEqual(equipmentStatusQueryOptions('unknown-site', 'fab-1').queryKey);

  expect(await queryClient.ensureQueryData(equipmentStatusQueryOptions('site-a', 'fab-1'))).toEqual(STATUS_A);
  expect(acceptEquipmentStatusSnapshot(queryClient, scope, { ...STATUS_A, fabId: 'unknown-fab', sequence: 9 })).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(queryClient, scope, { ...STATUS_A, siteId: 'unknown-site', sequence: 9 })).toBeUndefined();
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-a', 'fab-1'))).toEqual(STATUS_A);
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-a', 'unknown-fab'))).toBeUndefined();
  expect(queryClient.getQueryData(equipmentStatusQueryKey('unknown-site', 'fab-1'))).toBeUndefined();
  expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
    '/api/v1/sites/site-a/fabs/fab-1/equipment-status',
  ]);
});

it('A02/A03: a first REST frame is accepted once and stored under the FAB-scoped key with its epoch', async () => {
  const frame = { ...statusFrame('site-a', 'fab-1', 1, '2026-10-27T00:00:01Z'), epoch: 2 };
  const fetchMock = vi.fn(async () => jsonResponse(frame));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();

  const result = await queryClient.fetchQuery(equipmentStatusQueryOptions('site-a', 'fab-1'));
  const cached = queryClient.getQueryData<EquipmentStatusSnapshot>(equipmentStatusQueryKey('site-a', 'fab-1'));
  expect(result).toEqual(frame);
  expect(cached).toEqual(frame);
  expect(cached?.epoch).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('A02: a REST poll resolving after a newer SSE frame cannot regress the FAB-scoped cache', async () => {
  const scope = { siteId: 'site-a', fabId: 'fab-1' };
  const rest = { frame: statusFrame('site-a', 'fab-1', 3, '2026-10-27T00:00:03Z') };
  const fetchMock = vi.fn(async () => jsonResponse(rest.frame));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();

  expect((await queryClient.fetchQuery(equipmentStatusQueryOptions('site-a', 'fab-1'))).sequence).toBe(3);
  // The SSE listener writes through the exact same acceptance boundary.
  const newer = statusFrame('site-a', 'fab-1', 5, '2026-10-27T00:00:05Z', 'down');
  expect(acceptEquipmentStatusSnapshot(queryClient, scope, newer)?.sequence).toBe(5);

  // A delayed REST response that is older than the accepted SSE frame is routed
  // through the gate, rejected, and cannot overwrite the cache.
  rest.frame = statusFrame('site-a', 'fab-1', 4, '2026-10-27T00:00:04Z', 'maint');
  const late = await queryClient.fetchQuery(equipmentStatusQueryOptions('site-a', 'fab-1'));
  const cached = queryClient.getQueryData<EquipmentStatusSnapshot>(equipmentStatusQueryKey('site-a', 'fab-1'));
  expect(late.sequence).toBe(5);
  expect(late.tools[0].state).toBe('down');
  expect(cached?.sequence).toBe(5);
  expect(cached?.tools[0].state).toBe('down');
});
