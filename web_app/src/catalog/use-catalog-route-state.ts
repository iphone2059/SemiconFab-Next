import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect } from 'react';
import type { MouseEvent } from 'react';
import { localeActions, localeAtom } from '@/state/locale.atom';
import { languageTag, readPreferences, type Preferences } from '@/state/preferences.atom';
import { searchToQueryString, type RouterSearch } from '@/routes/route-search';
import { catalogSearchFrom, catalogSearchPatch } from '@/catalog/catalog-search';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';
import { text, type Language } from '@/catalog/catalog-labels';
import type { CatalogView } from '@/catalog/catalog-types';

function preferencesFromSearch(search: RouterSearch): Preferences {
  const query = searchToQueryString(search);
  try {
    return readPreferences(localStorage, query);
  } catch {
    return readPreferences({ getItem: () => null }, query);
  }
}

export interface CatalogRouteStateOptions {
  initialView: CatalogView;
  /** Router-owned search state; the page never reads window.location for product state. */
  search: RouterSearch;
  onSearchChange: (patch: Partial<RouterSearch>, replace?: boolean) => void;
  onViewChange: (next: CatalogView, patch: Partial<RouterSearch>) => void;
  entries: readonly { recordId: string; category: string }[];
}

/** URL/search coordination plus the view-transition helpers the shell needs. */
export interface CatalogRouteState {
  view: CatalogView;
  preferences: Preferences;
  language: Language;
  openView: (next: CatalogView) => void;
  hrefFor: (next: CatalogView) => string;
  navigate: (event: MouseEvent<HTMLAnchorElement>, next: CatalogView) => void;
}

/**
 * URL is the owner: search changes hydrate the page state (first load,
 * back/forward, programmatic navigation) and the current store snapshot is
 * written back once per commit. The two directions stay in one controller so
 * the single authoritative source is explicit.
 */
export function useCatalogRouteState(options: CatalogRouteStateOptions): CatalogRouteState {
  const registry = useContext(RegistryContext);
  const { initialView, search, onSearchChange, onViewChange, entries } = options;
  const catalogState = useAtomValue(catalogAtom);
  const preferences = useAtomValue(localeAtom);
  const language = preferences.language;
  const { view, domain, category, query, hideDrafts, selected } = catalogState;
  // Derive primitive route values so the effects depend on stable values instead
  // of the router's per-navigation search object (React Compiler/Oxlint contract).
  const route = catalogSearchFrom(search);
  const routeDomain = route.domain;
  const routeCategory = route.category;
  const routeQuery = route.query;
  const routeHideDrafts = route.hideDrafts;
  const routeCompare = route.compare;
  const routeCompareKey = routeCompare.join(',');
  const routePreferences = preferencesFromSearch(search);
  const routeLanguage = routePreferences.language;
  const routeTheme = routePreferences.theme;

  useEffect(() => {
    catalogActions.hydrate(registry, {
      view: initialView,
      domain: routeDomain,
      category: routeCategory,
      query: routeQuery,
      hideDrafts: routeHideDrafts,
      selected: routeCompareKey ? routeCompareKey.split(',') : [],
      page: 0,
    });
    localeActions.preferencesSet(registry, { language: routeLanguage, theme: routeTheme });
  }, [initialView, routeDomain, routeCategory, routeQuery, routeHideDrafts, routeCompareKey, routeLanguage, routeTheme, registry]);

  useEffect(() => {
    if (view !== 'compare' || selected.length > 0 || entries.length === 0) return;
    if (routeCompareKey.length > 0) return;
    catalogActions.selectedSet(registry,
      entries.filter((entry) => entry.category === 'lithography').slice(0, 3).map((entry) => entry.recordId),
    );
  }, [view, selected.length, entries, routeCompareKey, registry]);

  useEffect(() => {
    // Hydration (or another effect) can replace these snapshots earlier in this
    // commit. Only write the current render back; otherwise URL input and old
    // store values repeatedly overwrite each other.
    if (registry.get(catalogAtom) !== catalogState || registry.get(localeAtom) !== preferences) return;
    // A view switch is a route navigation owned by onViewChange. Writing the old
    // route's search back while that navigation is in flight would cancel it (the
    // catalog route would win and the header Compare link would never render the
    // comparison route). Wait until the router exposes the new initialView.
    if (view !== initialView) return;
    document.documentElement.lang = languageTag(language);
    document.title = `${text(
      language,
      view === 'compare' ? '设备对比' : '设备目录',
      view === 'compare' ? 'Equipment comparison' : 'Equipment catalog',
    )} · SemiconFab Next`;
    try {
      localStorage.setItem('semiconfab_lang', languageTag(language));
      localStorage.setItem('semicon_lang', language);
      localStorage.setItem('semicon_theme', preferences.theme);
    } catch {
      /* Storage may be unavailable. */
    }
    const patch = catalogSearchPatch({
      domain,
      category,
      query,
      hideDrafts,
      selected,
      language,
      theme: preferences.theme,
    });
    if (searchToQueryString({ ...search, ...patch }) !== searchToQueryString(search)) {
      onSearchChange(patch, true);
    }
  }, [catalogState, preferences, language, view, initialView, domain, category, query, selected, hideDrafts, search, onSearchChange, registry]);

  function openView(next: CatalogView): void {
    const patch = {
      ...catalogSearchPatch({
        domain,
        category,
        query,
        hideDrafts,
        selected,
        language,
        theme: preferences.theme,
      }),
      compare: selected.join(',') || undefined,
    };
    catalogActions.viewSet(registry, next);
    onViewChange(next, patch);
  }

  function hrefFor(next: CatalogView): string {
    const patch = {
      ...catalogSearchPatch({
        domain,
        category,
        query,
        hideDrafts,
        selected,
        language,
        theme: preferences.theme,
      }),
      compare: next === 'compare' ? selected.join(',') || undefined : undefined,
    };
    const qs = searchToQueryString({ ...search, ...patch });
    return `${next === 'compare' ? '/equipment/compare' : '/equipment'}${qs ? `?${qs}` : ''}`;
  }

  function navigate(event: MouseEvent<HTMLAnchorElement>, next: CatalogView): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openView(next);
  }

  return { view, preferences, language, openView, hrefFor, navigate };
}
