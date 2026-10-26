/**
 * Pure URL mapping for the V2.1 M1 route scheme. Keeping the mapping free of
 * React/Router imports lets the integration tests and catalog-data.ts share one
 * source of truth for canonical and permanent legacy alias paths.
 *
 * Canonical scheme (must never be renamed):
 *   /                          workbench
 *   /fabs/$fabId               FAB overview entry (M1 redirects to /3d)
 *   /fabs/$fabId/3d            3D FAB page
 *   /equipment                 equipment catalog
 *   /equipment/compare         equipment comparison
 *
 * Reserved for a later milestone (no routes are created in M1):
 *   /equipment/$equipmentId, /amhs, /alarms  (AMHS/alarms take ?fabId= once
 *   multi-FAB exists; the product is single-FAB in M1).
 */

/** Permanent legacy aliases; they must keep redirecting forever. */
export const LEGACY_TWIN_PATHS = ['/twin', '/twin.html', '/preview', '/preview.html'] as const;
export const LEGACY_CATALOG_PATHS = ['/catalog', '/catalog-demo', '/catalog-demo.html'] as const;
export const LEGACY_COMPARE_PATHS = ['/compare', '/compare.html'] as const;
export const LEGACY_WORKBENCH_PATHS = ['/workbench'] as const;

export type LegacyAliasTarget = 'twin' | 'equipment' | 'compare' | 'workbench';

/** Fixed canonical destinations; the twin target needs a resolved FAB id. */
export type StaticRedirectTarget = '/' | '/equipment' | '/equipment/compare';

const STATIC_PATHS: Readonly<Record<Exclude<LegacyAliasTarget, 'twin'>, StaticRedirectTarget>> = {
  workbench: '/',
  equipment: '/equipment',
  compare: '/equipment/compare',
};

const FAB_3D_PATH = /^\/fabs\/([^/]+)\/3d\/?$/;
const FAB_OVERVIEW_PATH = /^\/fabs\/([^/]+)\/?$/;

/** Escape a FAB id for a pathname when a pure mapping has to build the URL. */
export function fab3dPath(fabId: string): string {
  return `/fabs/${encodeURIComponent(fabId)}/3d`;
}

/** Permanent legacy alias kind, or undefined when the path is not an alias. */
export function legacyAliasTarget(pathname: string): LegacyAliasTarget | undefined {
  const path = pathname.replace(/\/+$/, '') || '/';
  if ((LEGACY_TWIN_PATHS as readonly string[]).includes(path)) return 'twin';
  if ((LEGACY_CATALOG_PATHS as readonly string[]).includes(path)) return 'equipment';
  if ((LEGACY_COMPARE_PATHS as readonly string[]).includes(path)) return 'compare';
  if ((LEGACY_WORKBENCH_PATHS as readonly string[]).includes(path)) return 'workbench';
  return undefined;
}

/** Canonical pathname for a legacy alias that needs no FAB id. */
export function staticRedirectPath(alias: Exclude<LegacyAliasTarget, 'twin'>): StaticRedirectTarget {
  return STATIC_PATHS[alias];
}

/** Normalize a canonical pathname; /fabs/$fabId is promoted to its /3d page. */
export function canonicalizePathname(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return '/';
  if (path === '/equipment') return '/equipment';
  if (path === '/equipment/compare') return '/equipment/compare';
  const fab3d = FAB_3D_PATH.exec(path);
  if (fab3d) return `/fabs/${fab3d[1]}/3d`;
  const overview = FAB_OVERVIEW_PATH.exec(path);
  if (overview) return `/fabs/${overview[1]}/3d`;
  return undefined;
}

/** View name shared with the transitional catalog URL hydration code. */
export function routeViewForPathname(pathname: string): 'workbench' | 'twin' | 'catalog' | 'compare' {
  const path = pathname.replace(/\/+$/, '') || '/';
  const alias = legacyAliasTarget(path);
  if (alias === 'twin') return 'twin';
  if (alias === 'equipment') return 'catalog';
  if (alias === 'compare') return 'compare';
  if (alias === 'workbench') return 'workbench';
  if (FAB_3D_PATH.test(path) || FAB_OVERVIEW_PATH.test(path)) return 'twin';
  if (path === '/equipment') return 'catalog';
  if (path === '/equipment/compare') return 'compare';
  return 'workbench';
}

/**
 * Full alias/canonical -> canonical pathname mapping. Returns undefined for an
 * unknown path or for a twin alias before a FAB id has been resolved.
 */
export function resolveCanonicalPath(pathname: string, resolvedFabId?: string): string | undefined {
  const canonical = canonicalizePathname(pathname);
  if (canonical) return canonical;
  const alias = legacyAliasTarget(pathname);
  if (alias === undefined) return undefined;
  if (alias === 'twin') return resolvedFabId === undefined ? undefined : fab3dPath(resolvedFabId);
  return STATIC_PATHS[alias];
}
