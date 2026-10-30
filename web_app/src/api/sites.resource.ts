import { Effect } from 'effect';
import { sitesSchema } from '@/api/sites.schema';
import type { FabDto, SiteDto } from '@/contracts/app-contracts';
import type { FabIdentity } from '@/domain/fab-identity';
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

/**
 * Exact composite (siteId, fabId) lookup (ADR-007 §3). A FAB is identified by
 * both ids: a bare fabId is not unique across sites, so there is no first-match
 * fallback and no site inference from a fabId. Returns the configured Site and
 * its FAB only when the pair exists in the sites document.
 */
export function findSiteFab(
  sites: readonly SiteDto[],
  identity: FabIdentity,
): { site: SiteDto; fab: FabDto } | undefined {
  const site = sites.find((value) => value.siteId === identity.siteId);
  if (!site) return undefined;
  const fab = site.fabs.find((value) => value.fabId === identity.fabId);
  return fab === undefined ? undefined : { site, fab };
}
