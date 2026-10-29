import { queryOptions } from '@tanstack/react-query';
import { Effect } from 'effect';
import { sitesSchema } from '@/api/sites.schema';
import type { SiteDto } from '@/contracts/app-contracts';
import { createHttpTransport, decodeApiResponse, type ApiError, type FetchLike } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

/** Native API boundary; only the Query adapter runs this Effect as a Promise. */
export function fetchSites(fetcher?: FetchLike): Effect.Effect<SiteDto[], ApiError> {
  return createHttpTransport({ fetchImpl: fetcher }).fetchJson('/api/v1/sites').pipe(
    Effect.flatMap(decodeApiResponse(sitesSchema, '站点响应格式无效 / invalid sites response')),
  );
}
export const sitesQueryOptions = () => queryOptions({
  queryKey: queryKeys.sites.all,
  queryFn: ({ signal }) => Effect.runPromise(fetchSites(), { signal }), staleTime: 30_000,
});

/** Route-param -> site lookup; the URL owns FAB identity in M1. */
export function findSiteByFabId(sites: readonly SiteDto[], fabId: string): SiteDto | undefined {
  return sites.find((site) => site.fabs.some((fab) => fab.fabId === fabId));
}
