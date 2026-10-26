// @vitest-environment jsdom
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { routerSearchSchema } from '../../src/app/router/search';

/**
 * RQ-01/RQ-05 acceptance coverage on a synthetic route tree. The product route
 * tree is intentionally not imported here: its pages pull Babylon/WebGPU code
 * that is irrelevant to the Query cache contract.
 */

const SITES = [
  { siteId: 'site-1', code: 'SITE-1', templateHash: 'hash-1', fabs: [{ fabId: 'FAB-01', code: 'FAB-01' }] },
];

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

function IndexScreen() {
  return <div>workbench</div>;
}

function FabScreen() {
  return <div>3d fab</div>;
}

function buildRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: ({ context }) => context.queryClient.ensureQueryData(sitesQueryOptions()),
    component: IndexScreen,
  });
  const fabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fabs/$fabId/3d',
    loader: ({ context }) => context.queryClient.ensureQueryData(sitesQueryOptions()),
    component: FabScreen,
  });
  const routeTree = rootRoute.addChildren([indexRoute, fabRoute]);
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

afterEach(() => vi.unstubAllGlobals());

it('preloads with intent, then navigates from the same Query cache with one fetch (RQ-01)', async () => {
  const fetchMock = vi.fn(async () => jsonResponse(SITES));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = newQueryClient();
  const router = buildRouter(queryClient);
  expect(router.options.defaultPreload).toBe('intent');
  expect(router.options.defaultPreloadStaleTime).toBe(0);

  await router.load();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const cached = queryClient.getQueryData(sitesQueryOptions().queryKey);
  expect(cached).toEqual(SITES);
  expect(router.state.matches.at(-1)?.loaderData).toBe(cached);

  // Preloading the target route reuses the fresh Query entry.
  const preloaded = await router.preloadRoute({ to: '/fabs/$fabId/3d', params: { fabId: 'FAB-01' } });
  expect(preloaded?.at(-1)?.loaderData).toBe(cached);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // defaultPreloadStaleTime 0 makes the route match stale, but the loader's
  // ensureQueryData still resolves from the single Query-cache entry.
  await router.navigate({ to: '/fabs/$fabId/3d', params: { fabId: 'FAB-01' } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(router.state.matches.at(-1)?.loaderData).toBe(cached);
  expect(queryClient.getQueryData(sitesQueryOptions().queryKey)).toBe(cached);
});

it('deduplicates overlapping ensureQueryData/fetchQuery calls into one in-flight request (RQ-05)', async () => {
  let resolveResponse!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = newQueryClient();

  const first = queryClient.ensureQueryData(sitesQueryOptions());
  const second = queryClient.fetchQuery(sitesQueryOptions());
  expect(fetchMock).toHaveBeenCalledTimes(1);

  resolveResponse(jsonResponse(SITES));
  const [firstData, secondData] = await Promise.all([first, second]);
  expect(firstData).toEqual(SITES);
  expect(secondData).toEqual(SITES);
  expect(firstData).toBe(secondData);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('forwards the validated search params through a redirect', async () => {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    validateSearch: routerSearchSchema,
    component: () => <Outlet />,
  });
  const legacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/legacy-alias',
    beforeLoad: () => {
      throw redirect({ to: '/', search: true, replace: true });
    },
    component: IndexScreen,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: IndexScreen,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([legacyRoute, homeRoute]),
    context: { queryClient: newQueryClient() },
    history: createMemoryHistory({
      initialEntries: ['/legacy-alias?lang=en&theme=dark&siteId=site-1&modal=arch&mode=engineer&perf=1&domain=fab&category=lithography&q=A%26B&hideDrafts=1&compare=id-1,id-2'],
    }),
  });
  await router.load();
  expect(router.state.location.pathname).toBe('/');
  expect(router.state.location.search).toMatchObject({
    lang: 'en',
    theme: 'dark',
    siteId: 'site-1',
    modal: 'arch',
    mode: 'engineer',
    perf: 1,
    domain: 'fab',
    category: 'lithography',
    q: 'A&B',
    hideDrafts: 1,
    compare: 'id-1,id-2',
  });
});
