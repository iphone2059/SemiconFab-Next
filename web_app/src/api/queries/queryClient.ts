import { QueryClient } from '@tanstack/react-query';

/**
 * The single application QueryClient. Route loaders receive it through the
 * TanStack Router context, so preloading and navigation share one cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export type AppQueryClient = typeof queryClient;
