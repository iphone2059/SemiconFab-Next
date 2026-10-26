import { createFileRoute } from '@tanstack/react-router';
import { TwinPage } from '../../../../../twin-page';
import { requireFabSites } from '../../../route-data';

/** Canonical 3D FAB page. The FAB identity comes from the route param. */
export const Route = createFileRoute('/fabs/$fabId/3d')({
  loader: async ({ context, params }) => {
    const site = await requireFabSites(context.queryClient, params.fabId);
    return { fabId: params.fabId, siteId: site.siteId };
  },
  component: FabSceneRoute,
});

function FabSceneRoute() {
  const { fabId } = Route.useParams();
  return <TwinPage fabId={fabId} />;
}
