import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { TwinPage } from '../../../../../features/twin/twin-page';
import { requireFabSites } from '../../../route-data';
import type { RouterSearch } from '../../../search';

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
  return <TwinPage fabId={fabId} search={search} onSearchChange={updateSearch} />;
}
