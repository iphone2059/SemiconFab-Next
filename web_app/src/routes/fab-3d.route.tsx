import { lazy, Suspense } from 'react';
import { createRoute } from '@tanstack/react-router';
import { requireFabIdentity } from '@/routes/route-data';
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

/**
 * Canonical 3D FAB page. The composite (siteId, fabId) identity comes from the
 * route params; the loader validates exact membership and the URL/search state
 * comes from the router. The old /fabs/$fabId/3d shape does not exist.
 */
export const fab3dRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sites/$siteId/fabs/$fabId/3d',
  validateSearch: decodeRouterSearch,
  loader: async ({ context, params }) => {
    const { site, fab } = await requireFabIdentity(context.appRuntime, { siteId: params.siteId, fabId: params.fabId });
    return { siteId: site.siteId, fabId: fab.fabId };
  },
  component: FabSceneRoute,
});

function FabSceneRoute() {
  const { siteId, fabId } = fab3dRoute.useParams();
  const search = fab3dRoute.useSearch();
  const navigate = fab3dRoute.useNavigate();
  const updateSearch = (patch: Partial<RouterSearch>, replace = true) => {
    void navigate({ search: (prev: RouterSearch) => ({ ...prev, ...patch }), replace });
  };
  return (
    <Suspense fallback={<FabSceneLoading />}>
      <TwinPage siteId={siteId} fabId={fabId} search={search} onSearchChange={updateSearch} />
    </Suspense>
  );
}
