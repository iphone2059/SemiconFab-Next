import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { equipmentStatusQueryKey, equipmentStatusQueryOptions } from '../src/api/queries/equipment.queries';
import { FAB_LAYOUT } from '../src/fab-layout';
import { runsQueryOptions, runQueryOptions, runResultsQueryOptions } from '../src/api/queries/runs.queries';
import { createRun } from '../src/api/mutations/runs.mutations';

/**
 * Transport parity for the M2 Query modules: the RTK fetchBaseQuery contract
 * (same-origin, no-store, relative URL, no browser dev key) and ProblemDetails
 * handling move to fetchJson/fetchText without changing observable behavior.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };
/** A real FAB frame always carries one valid state per layout tool. */
const fullTools = (state = 'running') => FAB_LAYOUT.map(() => ({ state }));
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => vi.unstubAllGlobals());

function captureFetch(response: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

it('uses FAB-scoped relative URLs, same-origin credentials, no-store and no browser dev key', async () => {
  const calls = captureFetch(() => jsonResponse({
    siteId: 'site/1', fabId: 'fab/1', generatedAt: '2026-10-27T00:00:00Z', sequence: 1, tools: fullTools(),
  }));
  await client().fetchQuery(equipmentStatusQueryOptions('site/1', 'fab/1'));
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/api/v1/sites/site%2F1/fabs/fab%2F1/equipment-status');
  expect(calls[0].init?.credentials).toBe('same-origin');
  expect(calls[0].init?.cache).toBe('no-store');
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.has('X-Fab-Dev-Key')).toBe(false);
});

it('encodes run ids and keeps list/detail/result endpoints distinct', async () => {
  const calls = captureFetch(() => jsonResponse([]));
  const queryClient = client();
  await queryClient.fetchQuery(runsQueryOptions());
  await queryClient.fetchQuery(runQueryOptions('run/1')).catch(() => undefined);
  await queryClient.fetchQuery(runResultsQueryOptions('run/1')).catch(() => undefined);
  expect(calls.map((call) => call.url)).toEqual([
    '/api/v1/runs',
    '/api/v1/runs/run%2F1',
    '/api/v1/runs/run%2F1/results',
  ]);
});

it('sends JSON and Idempotency-Key on createRun', async () => {
  const calls = captureFetch(() => jsonResponse({ runId: 'r1', siteId: 's1', status: 'QUEUED', version: '1', createdAtUtc: 'now', executions: [] }));
  await createRun({ request: { lotCount: 3 }, idempotencyKey: 'idem-1' });
  expect(calls[0].url).toBe('/api/v1/runs');
  expect(calls[0].init?.method).toBe('POST');
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(headers.get('Idempotency-Key')).toBe('idem-1');
  expect(calls[0].init?.body).toBe(JSON.stringify({ lotCount: 3 }));
});

it('preserves ProblemDetails and non-JSON gateway errors', async () => {
  vi.stubGlobal('fetch', async () => jsonResponse({ title: '身份拒绝', detail: '缺少开发密钥' }, 401));
  await expect(client().fetchQuery(runsQueryOptions())).rejects.toThrow(/缺少开发密钥/);
  vi.stubGlobal('fetch', async () => new Response('Bad gateway', { status: 502 }));
  await expect(client().fetchQuery(runsQueryOptions())).rejects.toThrow(/Bad gateway/);
});

it('rejects an invalid payload before it reaches the cache', async () => {
  vi.stubGlobal('fetch', async () => jsonResponse({ siteId: 1, generatedAt: 'now', tools: [] }));
  await expect(client().fetchQuery(equipmentStatusQueryOptions('site-1', 'fab-1'))).rejects.toThrow();
  // FAB identity is part of the contract: a site-only snapshot must not be cached.
  vi.stubGlobal('fetch', async () => jsonResponse({ siteId: 'site-1', generatedAt: 'now', tools: [{ state: 'UP' }] }));
  await expect(client().fetchQuery(equipmentStatusQueryOptions('site-1', 'fab-1'))).rejects.toThrow(/fabId/);
});
it('A03: keeps the additive server epoch through the zod REST schema', async () => {
  // zod strips unknown keys by default, so the epoch must be part of the schema or
  // REST frames would lose the only field that orders server generations.
  vi.stubGlobal('fetch', async () => jsonResponse({
    siteId: 'site-1', fabId: 'fab-1', generatedAt: '2026-10-27T00:00:00Z',
    sequence: 1, epoch: 7, tools: fullTools(),
  }));
  const snapshot = await client().fetchQuery(equipmentStatusQueryOptions('site-1', 'fab-1'));
  expect(snapshot.sequence).toBe(1);
  expect(snapshot.epoch).toBe(7);
});

it('A02: a partial FAB frame is rejected by the shared ordered gate before the cache', async () => {
  vi.stubGlobal('fetch', async () => jsonResponse({
    siteId: 'site-1', fabId: 'fab-1', generatedAt: '2026-10-27T00:00:00Z', sequence: 1,
    tools: [{ state: 'running' }],
  }));
  const queryClient = client();
  await expect(queryClient.fetchQuery(equipmentStatusQueryOptions('site-1', 'fab-1')))
    .rejects.toThrow(/ordered acceptance gate/);
  expect(queryClient.getQueryData(equipmentStatusQueryKey('site-1', 'fab-1'))).toBeUndefined();
});
