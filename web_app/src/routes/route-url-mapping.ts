/**
 * Canonical V2.1 route scheme. The legacy product URLs were deleted in M2:
 * there are no aliases and no redirects, so an old address is an honest 404.
 *
 *   /                          workbench / FAB overview
 *   /fabs/$fabId/3d            3D FAB page
 *   /equipment                 equipment catalog
 *   /equipment/compare         equipment comparison
 *
 * Reserved for later milestones (no routes yet):
 *   /equipment/$equipmentId, /amhs, /alarms
 */

const FAB_3D_PATH = /^\/fabs\/([^/]+)\/3d\/?$/;

/** Canonical 3D FAB pathname. */
export function fab3dPath(fabId: string): string {
  return `/fabs/${encodeURIComponent(fabId)}/3d`;
}

export type CanonicalView = 'workbench' | 'twin' | 'catalog' | 'compare';

/** View for a canonical pathname; undefined for deleted/unknown addresses. */
export function canonicalViewForPathname(pathname: string): CanonicalView | undefined {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'workbench';
  if (path === '/equipment') return 'catalog';
  if (path === '/equipment/compare') return 'compare';
  if (FAB_3D_PATH.test(path)) return 'twin';
  return undefined;
}
