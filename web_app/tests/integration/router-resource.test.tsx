import { afterEach, expect, it, vi } from 'vitest';
import { loadSites, requireFabSites } from '@/routes/route-data';
import { sitesDefinition } from '@/api/sites.resource';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

const sites = [{
  siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'SITE-1', templateHash: 'h'.repeat(64),
  fabs: [{ fabId: '37793fb6-5679-b7a3-3fef-d970433697c1', code: 'FAB-01' }],
}];
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
  await expect(requireFabSites(runtime, '37793fb6-5679-b7a3-3fef-d970433697c1')).resolves.toMatchObject({ siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await expect(requireFabSites(runtime, 'unknown-fab')).rejects.toThrow(/FAB 不存在/);
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
