import { z } from 'zod';
import type { CatalogDomain } from '../../catalog-data';

/**
 * Search params parsed on every canonical route. Every known key is optional and
 * falls back to `undefined` instead of failing the navigation, so a malformed
 * link can never blank the page.
 *
 * TanStack Router's default search parser JSON-parses values such as `1` or
 * `true`, so text params accept string/number/boolean and are re-serialized
 * symmetrically. The object is loose: unknown debug params are preserved
 * unchanged, while the listed product params stay validated.
 *
 * The helpers below are the single place that converts between the router search
 * object and the catalog/twin page state; pages no longer read `location` for
 * product state.
 */
const textParam = z.union([z.string(), z.number(), z.boolean()]).optional().catch(undefined);

export const routerSearchSchema = z.looseObject({
  lang: textParam,
  theme: z.enum(['dark', 'light']).optional().catch(undefined),
  siteId: textParam,
  modal: textParam,
  mode: textParam,
  perf: textParam,
  domain: textParam,
  category: textParam,
  q: textParam,
  hideDrafts: textParam,
  compare: textParam,
});

export type RouterSearch = z.infer<typeof routerSearchSchema>;

/** Coerce a validated router search value into display text. */
export function searchText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function searchFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Stable query-string form used for comparisons and preference parsing. */
export function searchToQueryString(search: RouterSearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

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
