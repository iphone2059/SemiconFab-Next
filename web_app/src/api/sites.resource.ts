import { Effect } from 'effect';
import { sitesSchema } from '@/api/sites.schema';
import type { SiteDto } from '@/contracts/app-contracts';
import { createHttpTransport, decodeApiResponse, type ApiError, type FetchLike } from '@/api/http.transport';
import { defineResource } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

/**
 * Native API boundary; the Resource Atom is the only server-snapshot owner
 * (ADR-006 §2.1). The definition is immutable and carries no request state, so
 * two AppRuntimes can never share an in-flight read through this module.
 */
export function fetchSites(fetcher?: FetchLike): Effect.Effect<SiteDto[], ApiError> {
  return createHttpTransport({ fetchImpl: fetcher }).fetchJson('/api/v1/sites').pipe(
    Effect.flatMap(decodeApiResponse(sitesSchema, '站点响应格式无效 / invalid sites response')),
  );
}

/** Static sites definition (30s freshness, 5min idle TTL). */
export const sitesDefinition = defineResource({
  identity: { kind: 'sites', version: 1, key: 'sites' },
  load: fetchSites(),
  policy: RESOURCE_POLICIES.sites,
});

/** Route-param -> site lookup; the URL owns FAB identity in M1. */
export function findSiteByFabId(sites: readonly SiteDto[], fabId: string): SiteDto | undefined {
  return sites.find((site) => site.fabs.some((fab) => fab.fabId === fabId));
}
