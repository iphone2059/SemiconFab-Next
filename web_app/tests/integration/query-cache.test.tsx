// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { equipmentStatusQueryOptions, equipmentStatusQueryKey } from '../../src/api/queries/equipment.queries';
import { acceptEquipmentStatusSnapshot } from '../../src/api/queries/equipment-status-bridge';
import { runsQueryOptions } from '../../src/api/queries/runs.queries';
import { createRun, invalidateRuns } from '../../src/api/mutations/runs.mutations';
import { FAB_LAYOUT } from '../../src/fab-layout';
import type { EquipmentStatusSnapshot } from '../../src/equipment-status';

/**
 * RQ-02/RQ-03/RQ-04 on the real TanStack Query modules (no RTK Query involved).
 * - RQ-02: a router loader keeps serving the cached value (ensureQueryData never
 *   forces a refetch), while the page subscription refetches on Query staleness.
 * - RQ-03: a mutation invalidates the runs prefix and the next read returns the
 *   authoritative server list.
 * - RQ-04: Query keys carry the (siteId, fabId) identity, so two FABs cannot
 *   share one equipment-status cache entry even inside the same site.
 * - A02/A03: REST frames pass the same per-scope ordered acceptance gate as SSE;
 *   a rejected/delayed frame can never regress the FAB-scoped cache entry.
 */

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
  tools: FAB_LAYOUT.map(() => ({ state })),
});
const STATUS_A = statusFrame('site-a', 'fab-1', 1, '2026-10-27T00:00:00Z');
const STATUS_B = statusFrame('site-a', 'fab-2', 1, '2026-10-27T00:00:00Z', 'down');

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
  const created = await createRun({ request: { scenario: 'm2' }, idempotencyKey: 'idem-1' });
  expect(created).toEqual(RUN_2);
  await invalidateRuns(queryClient);
  // The next read (component refetch or explicit fetch) is authoritative.
  expect(await queryClient.fetchQuery(runsQueryOptions())).toEqual([RUN_1, RUN_2]);
  expect(fetchMock).toHaveBeenCalledTimes(3); // GET, POST, invalidated GET
});

it('RQ-04: FAB-scoped Query keys isolate identical equipment ids per FAB', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/fabs/fab-1/')) return jsonResponse(STATUS_A);
    if (url.includes('/fabs/fab-2/')) return jsonResponse(STATUS_B);
    throw new Error('unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = freshClient();
  // Same site, different FABs: the composite identity must keep the keys apart.
  expect(equipmentStatusQueryOptions('site-a', 'fab-1').queryKey)
    .not.toEqual(equipmentStatusQueryOptions('site-a', 'fab-2').queryKey);

  expect(await queryClient.ensureQueryData(equipmentStatusQueryOptions('site-a', 'fab-1'))).toEqual(STATUS_A);
  expect(await queryClient.ensureQueryData(equipmentStatusQueryOptions('site-a', 'fab-2'))).toEqual(STATUS_B);
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-a', 'fab-1'))).toEqual(STATUS_A);
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-a', 'fab-2'))).toEqual(STATUS_B);
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-a', 'fab-1'))).not.toEqual(STATUS_B);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
    '/api/v1/sites/site-a/fabs/fab-1/equipment-status',
    '/api/v1/sites/site-a/fabs/fab-2/equipment-status',
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
