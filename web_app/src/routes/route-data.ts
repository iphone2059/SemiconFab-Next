import type { AppRuntime } from '@/app/app-runtime';
import type { FabDto, SiteDto } from '@/contracts/app-contracts';
import type { FabIdentity } from '@/domain/fab-identity';
import { findSiteFab, sitesDefinition } from '@/api/sites.resource';

/**
 * Route loaders read the sites document through the AppRuntime ResourceManager
 * (ADR-006 §2.10): a loader prefetch, intent preload and page mount share the same
 * manager handle, Atom and in-flight read. There are no redirects: an unavailable
 * API or an unknown FAB fails the route and the root error component owns the
 * retry/back path; no second cache or module-level promise exists.
 */
export async function loadSites(runtime: AppRuntime<never>): Promise<SiteDto[]> {
  return runtime.resources.ensure(runtime.resources.handle(sitesDefinition));
}

/**
 * Validates the exact composite (siteId, fabId) route identity against the
 * configured sites document. A FAB from another site is NOT a match (no
 * first-match across sites), so a nonexistent combination fails the route.
 */
export async function requireFabIdentity(
  runtime: AppRuntime<never>,
  identity: FabIdentity,
): Promise<{ site: SiteDto; fab: FabDto }> {
  const sites = await loadSites(runtime);
  const resolved = findSiteFab(sites, identity);
  if (!resolved) throw new Error(`FAB 不存在：${identity.fabId}`);
  return resolved;
}
