import type { AppRuntime } from '@/app/app-runtime';
import type { SiteDto } from '@/contracts/app-contracts';
import { ensureResource } from '@/api/resource';
import { findSiteByFabId, sitesResource } from '@/api/sites.resource';

/**
 * Route loaders read the sites document through the shared AppRuntime resource
 * facade; a loader prefetch, intent preload and page mount share the same Atom
 * and in-flight read. There are no redirects: an unavailable API or an unknown
 * FAB fails the route and the root error component owns the retry/back path.
 */
export async function loadSites(runtime: AppRuntime<never>): Promise<SiteDto[]> {
  return ensureResource(runtime, sitesResource);
}

export async function requireFabSites(runtime: AppRuntime<never>, fabId: string): Promise<SiteDto> {
  const sites = await loadSites(runtime);
  const site = findSiteByFabId(sites, fabId);
  if (!site) throw new Error(`FAB 不存在：${fabId}`);
  return site;
}
