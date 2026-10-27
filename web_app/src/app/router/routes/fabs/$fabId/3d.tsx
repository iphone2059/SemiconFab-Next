import { lazy, Suspense, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireFabSites } from '../../../route-data';
import type { RouterSearch } from '../../../search';

// ARCH G-01 freezes the Vite server/build parameters and forbids the router plugin
// from changing chunking, so the Twin page is split at the route boundary in
// source (the documented code-based fallback) instead of via autoCodeSplitting.
// The loader below keeps its synchronous Query data boundary; only the page
// component graph loads asynchronously, and the GPU backend keeps its own dynamic
// import inside the page.
const TwinPage = lazy(async () => {
  const module = await import('../../../../../features/twin/twin-page');
  return { default: module.TwinPage };
});

/** Same shell/Twin loading treatment the page uses while its FAB data resolves. */
function FabSceneLoading() {
  return <main className="twin-page twin-loading"><span>正在加载 FAB…</span></main>;
}

/** Canonical 3D FAB page. FAB identity comes from the route param; URL/search state comes from the router. */
export const Route = createFileRoute('/fabs/$fabId/3d')({
  loader: async ({ context, params }) => {
    const site = await requireFabSites(context.queryClient, params.fabId);
    return { fabId: params.fabId, siteId: site.siteId };
  },
  component: FabSceneRoute,
});

function FabSceneRoute() {
  const { fabId } = Route.useParams();
  const search = Route.useSearch() as RouterSearch;
  const navigate = Route.useNavigate();
  const updateSearch = useCallback((patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  }, [navigate]);
  return (
    <Suspense fallback={<FabSceneLoading />}>
      <TwinPage fabId={fabId} search={search} onSearchChange={updateSearch} />
    </Suspense>
  );
}
