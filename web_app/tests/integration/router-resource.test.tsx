import { afterEach, expect, it, vi } from 'vitest';
import { loadSites, requireFabIdentity } from '@/routes/route-data';
import { sitesDefinition } from '@/api/sites.resource';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

// Two Sites with distinct FABs: a fabId is only meaningful together with its
// owning siteId, so cross-site combinations must fail the route (ADR-007 §3).
const siteAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fabAId = '37793fb6-5679-b7a3-3fef-d970433697c1';
const fabBId = 'd84dc4f9-b7fc-c670-e78e-6e90b6b2de48';
const sites = [
  { siteId: siteAId, code: 'SITE-1', templateHash: 'h'.repeat(64), fabs: [{ fabId: fabAId, code: 'FAB-01' }] },
  { siteId: siteBId, code: 'SITE-2', templateHash: 'i'.repeat(64), fabs: [{ fabId: fabBId, code: 'FAB-02' }] },
];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

it('RES-01: loader prefetch and page ensure share one in-flight sites request', async () => {
  const fetch = vi.fn(async () => json(sites));
  vi.stubGlobal('fetch', fetch);
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  const [preloaded, mounted] = await Promise.all([
    loadSites(runtime),
    manager.ensure(manager.handle(sitesDefinition)),
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(preloaded).toEqual(mounted);
  expect(mounted).toEqual(sites);
  // A fresh page mount inside the 30s freshness window reuses the Atom.
  expect(await manager.ensure(manager.handle(sitesDefinition))).toEqual(sites);
  expect(fetch).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});

it('RES-02: an abandoned loader waiter does not abort the read used by other consumers', async () => {
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => setTimeout(() => resolve(json(sites)), 20));
  });
  vi.stubGlobal('fetch', fetch);
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  const abandoned = loadSites(runtime);
  const shared = manager.ensure(manager.handle(sitesDefinition));
  // The first promise is intentionally ignored: the resource read must still finish.
  void abandoned.catch(() => undefined);
  await expect(shared).resolves.toEqual(sites);
  expect(signal?.aborted).toBe(false);
  await runtime.dispose();
});

it('RES-03: unknown FAB fails the route from the same resource identity without redirect', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(sites)));
  const runtime = createTestRuntime();
  await expect(requireFabIdentity(runtime, { siteId: siteAId, fabId: fabAId })).resolves.toMatchObject({
    site: { siteId: siteAId },
    fab: { fabId: fabAId, code: 'FAB-01' },
  });
  for (const identity of [
    { siteId: siteAId, fabId: 'unknown-fab' },
    { siteId: siteAId, fabId: fabBId },
    { siteId: siteBId, fabId: fabAId },
    { siteId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', fabId: fabAId },
  ]) {
    await expect(requireFabIdentity(runtime, identity), JSON.stringify(identity)).rejects.toThrow(/FAB 不存在/);
  }
  await runtime.dispose();
});

it('R5.4-03-T09: only the exact configured combination resolves', async () => {
  const fetch = vi.fn(async () => json(sites));
  vi.stubGlobal('fetch', fetch);
  const runtime = createTestRuntime();
  await expect(requireFabIdentity(runtime, { siteId: siteBId, fabId: fabBId })).resolves.toMatchObject({
    site: { siteId: siteBId },
    fab: { fabId: fabBId, code: 'FAB-02' },
  });
  // Same-index FAB of the other site is a different identity, not a match.
  await expect(requireFabIdentity(runtime, { siteId: siteBId, fabId: fabAId })).rejects.toThrow(/FAB 不存在/);
  await runtime.dispose();
});

it('RES-04: loader failure is typed and a retry reuses the same Atom', async () => {
  const failing = vi.fn(async () => new Response(JSON.stringify({ title: '身份拒绝', detail: '缺少开发密钥' }), { status: 401 }));
  vi.stubGlobal('fetch', failing);
  const runtime = createTestRuntime();
  await expect(loadSites(runtime)).rejects.toThrow(/缺少开发密钥/);
  expect(runtime.resources.state(runtime.resources.handle(sitesDefinition))._tag).toBe('Failure');
  vi.stubGlobal('fetch', vi.fn(async () => json(sites)));
  await expect(loadSites(runtime)).resolves.toEqual(sites);
  await runtime.dispose();
});
