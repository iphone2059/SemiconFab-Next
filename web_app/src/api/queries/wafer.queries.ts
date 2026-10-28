import { queryOptions } from '@tanstack/react-query';
import { parseWaferRoutes } from '../../domain/wafer/wafer-route';
import { httpTransport } from '../transport/http';
import { queryKeys } from './queryKeys';

/** Static wafer route data; parsed with the existing contract parser. */
export const waferRoutesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.wafer.routes,
    queryFn: async ({ signal }) => parseWaferRoutes(await httpTransport.fetchJson('/twin/routes.json', { signal })),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });
