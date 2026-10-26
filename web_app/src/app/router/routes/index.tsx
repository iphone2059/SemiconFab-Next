import { createFileRoute } from '@tanstack/react-router';
import { sitesQueryOptions } from '../../../api/queries/sites.queries';
import WorkbenchApp from '../../../workbench';

/**
 * Canonical workbench URL. The Query cache is warmed here so WorkbenchApp renders
 * from the same cache the router preloaded; a failing API is handled by the
 * workbench's own error/retry UI instead of a route error screen.
 */
export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(sitesQueryOptions());
    } catch {
      /* WorkbenchApp shows the retryable site API error state. */
    }
  },
  component: WorkbenchApp,
});
