import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { SiteDto } from '../../contracts';
import { findSiteByFabId, sitesQueryOptions } from '../../api/queries/sites.queries';

/**
 * Route loaders only read the sites document through the shared Query cache
 * (`ensureQueryData`), never through a bespoke fetch. Invalid or unavailable
 * FAB data redirects to the workbench, which owns the retryable error state.
 */
export async function loadSitesOrRedirect(queryClient: QueryClient): Promise<SiteDto[]> {
  try {
    return await queryClient.ensureQueryData(sitesQueryOptions());
  } catch {
    throw redirect({ to: '/', search: true, replace: true });
  }
}

export async function requireFabSites(queryClient: QueryClient, fabId: string): Promise<SiteDto> {
  const sites = await loadSitesOrRedirect(queryClient);
  const site = findSiteByFabId(sites, fabId);
  if (!site) throw redirect({ to: '/', search: true, replace: true });
  return site;
}
