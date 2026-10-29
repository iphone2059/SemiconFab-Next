import { queryOptions } from '@tanstack/react-query';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { httpTransport } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

/** Static wafer route data; parsed with the existing contract parser. */
export const waferRoutesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.wafer.routes,
    queryFn: async ({ signal }) => parseWaferRoutes(await httpTransport.fetchJson('/twin/routes.json', { signal })),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });
