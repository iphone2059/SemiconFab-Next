import { lazy, Suspense, useCallback } from 'react';
import { createRoute } from '@tanstack/react-router';
import { requireFabSites } from '@/routes/route-data';
import type { RouterSearch } from './route-search';
import { decodeRouterSearch } from './route-search';
import { rootRoute } from './root.route';

// Vite server/build parameters stay frozen (ARCH G-01); the Twin page graph is split
// at the route boundary in source, and the GPU backend keeps its own dynamic import.
const TwinPage = lazy(async () => {
  const module = await import('@/twin/twin-page');
  return { default: module.TwinPage };
});

/** Same shell/Twin loading treatment the page uses while its FAB data resolves. */
function FabSceneLoading() {
  return <main className="twin-page twin-loading"><span>正在加载 FAB…</span></main>;
}

/** Canonical 3D FAB page. FAB identity comes from the route param; URL/search state comes from the router. */
export const fab3dRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fabs/$fabId/3d',
  validateSearch: decodeRouterSearch,
  loader: async ({ context, params }) => {
    const site = await requireFabSites(context.appRuntime, params.fabId);
    return { fabId: params.fabId, siteId: site.siteId };
  },
  component: FabSceneRoute,
});

function FabSceneRoute() {
  const { fabId } = fab3dRoute.useParams();
  const search = fab3dRoute.useSearch();
  const navigate = fab3dRoute.useNavigate();
  const updateSearch = useCallback((patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  }, [navigate]);
  return (
    <Suspense fallback={<FabSceneLoading />}>
      <TwinPage fabId={fabId} search={search} onSearchChange={updateSearch} />
    </Suspense>
  );
}
