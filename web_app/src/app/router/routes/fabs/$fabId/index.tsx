import { createFileRoute, redirect } from '@tanstack/react-router';
import { requireFabSites } from '../../../route-data';

/**
 * FAB overview entry: M1 validates that the FAB exists and redirects to the 3D
 * page. The /fabs/$fabId URL is final (a later milestone renders the overview
 * here); this index route is separate from the /3d child so the redirect never
 * loops when /fabs/$fabId/3d is the target.
 */
export const Route = createFileRoute('/fabs/$fabId/')({
  loader: async ({ context, params }) => {
    await requireFabSites(context.queryClient, params.fabId);
    throw redirect({ to: '/fabs/$fabId/3d', params: { fabId: params.fabId }, search: true, replace: true });
  },
});
