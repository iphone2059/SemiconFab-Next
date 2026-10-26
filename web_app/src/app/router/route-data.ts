import type { QueryClient } from '@tanstack/react-query';
import type { SiteDto } from '../../contracts';
import { findSiteByFabId, sitesQueryOptions } from '../../api/queries/sites.queries';

/**
 * Route loaders only read the sites document through the shared Query cache
 * (`ensureQueryData`), never through a bespoke fetch. There are no redirects:
 * an unavailable API or an unknown FAB fails the route and the root error
 * component owns the retry/back path.
 */
export async function loadSites(queryClient: QueryClient): Promise<SiteDto[]> {
  return queryClient.ensureQueryData(sitesQueryOptions());
}

export async function requireFabSites(queryClient: QueryClient, fabId: string): Promise<SiteDto> {
  const sites = await loadSites(queryClient);
  const site = findSiteByFabId(sites, fabId);
  if (!site) throw new Error(`FAB 不存在：${fabId}`);
  return site;
}
