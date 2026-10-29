import { createRouter } from '@tanstack/react-router';
import { queryClient } from '@/api/query-client';
import { routeTree } from './route-tree';

/**
 * Code-based route tree: no file-generation plugin and no generated route tree.
 * URL/search ownership stays with TanStack Router; data freshness belongs to the
 * Query cache (ensureQueryData in loaders) until the resource-atom migration.
 */
export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
