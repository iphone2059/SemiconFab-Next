import { createRoute } from '@tanstack/react-router';
import { sitesQueryOptions } from '@/api/sites.resource';
import WorkbenchApp from '@/workbench/workbench';
import { rootRoute } from './root.route';
import { decodeRouterSearch } from './route-search';

/**
 * Canonical workbench URL. The Query cache is warmed here so WorkbenchApp renders
 * from the same cache the router preloaded; a failing API is handled by the
 * workbench's own error/retry UI instead of a route error screen.
 */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: decodeRouterSearch,
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(sitesQueryOptions());
    } catch {
      /* WorkbenchApp shows the retryable site API error state. */
    }
  },
  component: WorkbenchApp,
});
