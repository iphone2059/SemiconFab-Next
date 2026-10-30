import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSites as fetchSitesEffect, findSiteFab, sitesDefinition } from '@/api/sites.resource';

const fetchSites = (...args: Parameters<typeof fetchSitesEffect>) => Effect.runPromise(fetchSitesEffect(...args));

// Two Sites deliberately configure the SAME fabId: only the composite
// (siteId, fabId) identity can distinguish them (ADR-007 §3).
const sites = [
  { siteId: 'site-a', code: 'SITE-A', templateHash: 'hash-a', fabs: [{ fabId: 'fab-01', code: 'FAB-A-01' }] },
  { siteId: 'site-b', code: 'SITE-B', templateHash: 'hash-b', fabs: [{ fabId: 'fab-01', code: 'FAB-B-01' }] },
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

it('exposes one freshness/idle-TTL policy for every sites consumer', () => {
  expect(sitesDefinition.policy).toEqual({ freshnessMs: 30_000, idleTtlMs: 300_000 });
  expect(sitesDefinition.identity).toEqual({ kind: 'sites', version: 1, key: 'sites' });
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

it('R5.4-03: resolves the exact composite FAB identity with no cross-site first match', () => {
  expect(findSiteFab(sites, { siteId: 'site-a', fabId: 'fab-01' })).toMatchObject({
    site: { siteId: 'site-a' },
    fab: { fabId: 'fab-01', code: 'FAB-A-01' },
  });
  expect(findSiteFab(sites, { siteId: 'site-b', fabId: 'fab-01' })).toMatchObject({
    site: { siteId: 'site-b' },
    fab: { fabId: 'fab-01', code: 'FAB-B-01' },
  });
  // A known fabId under the WRONG site is not a match; there is no fabId-only scan.
  expect(findSiteFab(sites, { siteId: 'site-a', fabId: 'fab-02' })).toBeUndefined();
  expect(findSiteFab(sites, { siteId: 'site-c', fabId: 'fab-01' })).toBeUndefined();
  expect(findSiteFab([], { siteId: 'site-a', fabId: 'fab-01' })).toBeUndefined();
});

it('resolves the single configured FAB by its supplied identity', async () => {
  const catalog = [{
    siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-1',
    fabs: [{ fabId: 'configured-fab', code: 'FAB-PRODUCT' }],
  }];
  const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(catalog));
  expect(await fetchSites(fetcher)).toEqual(catalog);
  expect(findSiteFab(catalog, { siteId: 'site-1', fabId: 'configured-fab' })?.fab.fabId).toBe('configured-fab');
  expect(findSiteFab(catalog, { siteId: 'site-1', fabId: 'FAB-01' })).toBeUndefined();
});
