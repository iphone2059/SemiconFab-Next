import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSites as fetchSitesEffect, findSiteByFabId, sitesQueryOptions } from '@/api/sites.resource';

const fetchSites = (...args: Parameters<typeof fetchSitesEffect>) => Effect.runPromise(fetchSitesEffect(...args));

const sites = [
  { siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-1', fabs: [{ fabId: 'FAB-01', code: 'FAB-01' }] },
];

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

it('fetches sites through the relative URL with RTK-equivalent transport options', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(sites));
  const result = await fetchSites(fetcher);
  expect(result).toEqual(sites);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/sites');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) });
});

it('exposes one query-key/staleTime contract for every sites consumer', () => {
  const options = sitesQueryOptions();
  expect(options.queryKey).toEqual(['sites']);
  expect(options.staleTime).toBe(30_000);
});

it('surfaces non-2xx ProblemDetails as a descriptive Error', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ title: '身份拒绝', detail: '缺少开发密钥' }), { status: 401 }));
  await expect(fetchSites(fetcher)).rejects.toThrow(/HTTP 401[\s\S]*缺少开发密钥/);
});

it('rejects non-JSON gateway bodies instead of reporting an empty sites list', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('Bad gateway', { status: 502 }));
  await expect(fetchSites(fetcher)).rejects.toThrow(/HTTP 502[\s\S]*Bad gateway/);
  const okButText = vi.fn<typeof fetch>(async () => new Response('not json', { status: 200 }));
  await expect(fetchSites(okButText)).rejects.toThrow(/非 JSON/);
});

it('validates the minimal sites document shape', async () => {
  const raw = vi.fn<typeof fetch>(async () => jsonResponse({ sites }));
  await expect(fetchSites(raw)).rejects.toThrow(/格式无效/);
  const missingFabs = vi.fn<typeof fetch>(async () => jsonResponse([{ siteId: 'site-1', code: 'SITE-1', templateHash: 'hash' }]));
  await expect(fetchSites(missingFabs)).rejects.toThrow(/fabs/);
  const emptyFabs = vi.fn<typeof fetch>(async () => jsonResponse([{ siteId: 'site-1', code: 'SITE-1', templateHash: 'hash', fabs: [] }]));
  await expect(fetchSites(emptyFabs)).rejects.toThrow(/fabs/);
});

it('looks sites up by FAB identity', () => {
  expect(findSiteByFabId(sites, 'FAB-01')?.siteId).toBe('site-1');
  expect(findSiteByFabId(sites, 'FAB-99')).toBeUndefined();
});

it('resolves the single configured FAB by its supplied identity', async () => {
  const catalog = [{
    siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-1',
    fabs: [{ fabId: 'configured-fab', code: 'FAB-PRODUCT' }],
  }];
  const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
  expect(await fetchSites(fetcher)).toEqual(catalog);
  expect(findSiteByFabId(catalog, 'configured-fab')?.siteId).toBe('site-1');
  expect(findSiteByFabId(catalog, 'FAB-01')).toBeUndefined();
});
