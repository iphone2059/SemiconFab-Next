import { createRouter } from '@tanstack/react-router';
import { queryClient } from '@/api/query-client';
import { applicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { routeTree } from './route-tree';

/**
 * One router factory bound to one AppRuntime. The product entry point and tests
 * use the same factory; the exported router instance is the application default
 * shared by RouterProvider and the provider tree.
 */
export function createAppRouter(runtime: AppRuntime<never>) {
  return createRouter({
    routeTree,
    context: { queryClient, appRuntime: runtime },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

export const router = createAppRouter(applicationRuntime);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
