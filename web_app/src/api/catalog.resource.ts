import type { CatalogPageDto } from '@/contracts/app-contracts';
import { Effect } from 'effect';
import { queryOptions } from '@tanstack/react-query';
import { catalogPageSchema } from '@/api/catalog.schema';
import { httpTransport, decodeApiResponse, type ApiError } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';
export const fetchCatalog = (): Effect.Effect<CatalogPageDto, ApiError> => httpTransport.fetchJson('/api/v1/catalog').pipe(
  Effect.flatMap(decodeApiResponse(catalogPageSchema, 'invalid catalog response')),
);
export const catalogQueryOptions = () => queryOptions({
  queryKey: queryKeys.catalog.all,
  queryFn: ({ signal }) => Effect.runPromise(fetchCatalog(), { signal }), staleTime: 60_000, retry: 0,
});
