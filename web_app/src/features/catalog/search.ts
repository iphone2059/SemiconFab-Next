import { searchFlag, searchText, type RouterSearch } from '../../app/router/search';
import type { CatalogDomain } from './catalog-data';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CatalogSearchState {
  domain: CatalogDomain;
  category: string;
  query: string;
  hideDrafts: boolean;
  compare: string[];
}

/** Read catalog filters/selection from the router search (URL is the owner). */
export function catalogSearchFrom(search: RouterSearch): CatalogSearchState {
  const domain = searchText(search.domain)?.toUpperCase();
  const compare = (searchText(search.compare) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => UUID_RE.test(value));
  return {
    domain: domain === 'FAB' || domain === 'OSAT' ? domain : 'ALL',
    category: searchText(search.category) ?? '',
    query: searchText(search.q) ?? '',
    hideDrafts: searchFlag(search.hideDrafts),
    compare: [...new Set(compare)].slice(0, 4),
  };
}

/** Build the search patch for the current catalog page state. */
export function catalogSearchPatch(input: {
  domain: CatalogDomain;
  category: string;
  query: string;
  hideDrafts: boolean;
  selected: string[];
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
}): Partial<RouterSearch> {
  return {
    domain: input.domain === 'ALL' ? undefined : input.domain.toLowerCase(),
    category: input.category || undefined,
    q: input.query || undefined,
    hideDrafts: input.hideDrafts ? 1 : undefined,
    compare: input.selected.length ? input.selected.join(',') : undefined,
    lang: input.language === 'en' ? 'en-US' : 'zh-CN',
    theme: input.theme,
  };
}
