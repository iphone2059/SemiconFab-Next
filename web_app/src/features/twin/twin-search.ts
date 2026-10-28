import { searchText, type RouterSearch } from '../../app/router/search';

/**
 * Twin-specific conversions from the generic router search object.
 *
 * They live in the owning feature so the generic router utility never mentions a
 * Twin type: any page/feature can add its own deep-link vocabulary without the
 * router growing feature knowledge.
 */
export type TwinModalSearch = 'database' | 'catalog' | 'arch' | 'yms';
export type TwinModeSearch = 'engineer' | 'visitor' | 'research';

export function twinModeFrom(search: RouterSearch): TwinModeSearch | undefined {
  const mode = searchText(search.mode);
  return mode === 'engineer' || mode === 'visitor' || mode === 'research' ? mode : undefined;
}

export function twinModalFrom(search: RouterSearch): TwinModalSearch | undefined {
  const modal = searchText(search.modal);
  return modal === 'database' || modal === 'catalog' || modal === 'arch' || modal === 'yms' ? modal : undefined;
}

export function twinSiteIdFrom(search: RouterSearch): string | undefined {
  return searchText(search.siteId);
}
