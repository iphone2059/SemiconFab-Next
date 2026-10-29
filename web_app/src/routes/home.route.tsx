import { createRoute } from '@tanstack/react-router';
import { sitesDefinition } from '@/api/sites.resource';
import WorkbenchApp from '@/workbench/workbench';
import { rootRoute } from './root.route';
import { decodeRouterSearch } from './route-search';

/**
 * Canonical workbench URL. The loader warms the same ResourceManager handle the
 * WorkbenchApp mount retains; a failing API is handled by the workbench's own
 * error/retry UI instead of a route error screen.
 */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: decodeRouterSearch,
  loader: async ({ context }) => {
    try {
      await context.appRuntime.resources.ensure(context.appRuntime.resources.handle(sitesDefinition));
    } catch {
      /* WorkbenchApp shows the retryable site API error state. */
    }
  },
  component: WorkbenchApp,
});
