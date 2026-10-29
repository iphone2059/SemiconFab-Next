import { Effect } from 'effect';
import { queryOptions } from '@tanstack/react-query';
import { parseWaferRoutes } from '@/domain/wafer-route';
import { httpTransport, InvalidServerResponse } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

/** Static wafer route data; parsed with the existing contract parser. */
export const waferRoutesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.wafer.routes,
    queryFn: ({ signal }) => Effect.runPromise(fetchWaferRoutes(), { signal }),
    staleTime: Infinity,
    gcTime: 600_000,
    retry: 0,
  });

export const fetchWaferRoutes = () => httpTransport.fetchJson('/twin/routes.json').pipe(Effect.flatMap(value => Effect.try({
  try: () => parseWaferRoutes(value),
  catch: cause => new InvalidServerResponse(cause instanceof Error ? cause.message : 'invalid wafer routes', cause),
})));
