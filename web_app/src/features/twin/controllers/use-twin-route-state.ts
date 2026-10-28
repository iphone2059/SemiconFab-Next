import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FabDto, SiteDto } from '../../../contracts';
import { sitesQueryOptions } from '../../../api/queries/sites.queries';
import { searchToQueryString, type RouterSearch } from '../../../app/router/search';
import { languageTag, readPreferences } from '../../../state/preferences';
import { useLocaleStore } from '../../../state/localeStore';
import { useTwinPageStore, twinPageActions } from '../state/twinPageStore';
import { useTwinUiStore, twinUiActions } from '../state/twinUiStore';
import type { EntryMode } from '../state/twin-state';
import { ONBOARDING_KEY } from '../twin-page-data';
import type { TwinLanguage } from '../twin-i18n';
import { twinModalFrom, twinModeFrom, twinSiteIdFrom } from '../twin-search';

export interface TwinRouteStateParams {
  fabId?: string;
  /** Router-owned search state; the page never reads window.location for product state. */
  search?: RouterSearch;
  onSearchChange?: (patch: Partial<RouterSearch>, replace?: boolean) => void;
  /** Page-store site fallback, used when TwinPage renders without a route param (SSR, tests). */
  siteId?: string;
  mode: EntryMode;
  language: TwinLanguage;
  theme: 'light' | 'dark';
  t: (text: string, parameters?: readonly unknown[]) => string;
}

export interface TwinRouteState {
  site?: SiteDto;
  fab?: FabDto;
  /** Canonical route identity wins; the site/first-FAB fallback fills the gap. */
  selectedFabId?: string;
  /** Site id that owns the FAB-scoped equipment status stream. */
  statusSiteId?: string;
}

/**
 * URL <-> store synchronization for the Twin page.
 *
 * The router search object is the owner of every persisted/deep-linked value
 * (mode, language, theme, legacy ?siteId= compatibility, modal deep links). This
 * hook mirrors it into the UI/locale/page stores and writes user changes back
 * through the router callback; nothing here touches history/location directly.
 * It also resolves the route FAB into the site/fab projection the page renders.
 */
export function useTwinRouteState({
  fabId,
  search,
  onSearchChange,
  siteId,
  mode,
  language,
  theme,
  t,
}: TwinRouteStateParams): TwinRouteState {
  const searchQuery = searchToQueryString(search ?? {});
  const sitesQuery = useQuery(sitesQueryOptions());

  // URL is the owner of persisted language/theme overrides; the store is synced
  // from the router search and writes back through it (no history/location use).
  useEffect(() => {
    try {
      useLocaleStore.setState(readPreferences(localStorage, searchQuery), true);
    } catch {
      /* Storage denial must not prevent opening the FAB. */
    }
  }, [searchQuery]);

  useEffect(() => {
    const requested = twinModeFrom(search ?? {});
    if (requested && useTwinUiStore.getState().entryMode !== requested) twinUiActions.modeSet(requested);
  }, [search?.mode]);

  useEffect(() => {
    if (useTwinUiStore.getState().entryMode !== mode) return;
    const patch = { mode };
    if (searchToQueryString({ ...(search ?? {}), ...patch }) !== searchQuery) onSearchChange?.(patch, true);
  }, [mode, onSearchChange, search, searchQuery]);

  useEffect(() => {
    const current = useLocaleStore.getState();
    if (current.language !== language || current.theme !== theme) return;
    const patch = { lang: languageTag(language), theme };
    if (searchToQueryString({ ...(search ?? {}), ...patch }) !== searchQuery) onSearchChange?.(patch, true);
  }, [language, theme, onSearchChange, search, searchQuery]);

  useEffect(() => {
    if (!sitesQuery.data) return;
    // Canonical route identity (/fabs/$fabId/3d) wins over the transitional
    // ?siteId= compatibility parameter; the legacy parameter is still honoured
    // when the route does not carry a FAB id.
    const legacySiteId = twinSiteIdFrom(search ?? {});
    let next: SiteDto | undefined;
    if (fabId) {
      next = sitesQuery.data.find((value) => value.fabs.some((fabValue) => fabValue.fabId === fabId));
      if (!next) {
        twinPageActions.siteErrorSet(t("指定的 FAB 不存在：{0}", [fabId]));
        return;
      }
    } else if (siteId) {
      return;
    } else {
      next = legacySiteId ? sitesQuery.data.find((value) => value.siteId === legacySiteId) : sitesQuery.data[0];
      if (!next) {
        twinPageActions.siteErrorSet(legacySiteId ? t("指定的 FAB 站点不存在：{0}", [legacySiteId]) : t("没有可用的 FAB 站点"));
        return;
      }
    }
    // Multiple FABs are a first-class product shape: the route/first-FAB fallback
    // selects one FAB, it never rejects the site for having more than one.
    if (useTwinPageStore.getState().siteId !== next.siteId) twinPageActions.siteIdSet(next.siteId);
    if (useTwinPageStore.getState().siteError !== undefined) twinPageActions.siteErrorSet(undefined);
  }, [sitesQuery.data, siteId, fabId, t]);

  useEffect(() => {
    if (!sitesQuery.error) return;
    twinPageActions.siteErrorSet(sitesQuery.error instanceof Error ? sitesQuery.error.message : t('FAB 数据加载失败'));
  }, [sitesQuery.error, t]);

  useEffect(() => {
    const modal = twinModalFrom(search ?? {});
    if (modal === 'database' || modal === 'catalog') twinPageActions.infoDialogSet('database');
    else if (modal === 'arch') twinPageActions.infoDialogSet('architecture');
    else if (modal === 'yms') { twinPageActions.ymsOpenSet(true); twinPageActions.ymsTabSet('map'); }
  }, [search?.modal]);

  useEffect(() => {
    try {
      const modal = twinModalFrom(search ?? {});
      if (!modal && localStorage.getItem(ONBOARDING_KEY) !== '1') twinUiActions.onboardingOpen();
    } catch {
      // Storage may be blocked; the page still works without onboarding memory.
    }
  }, [search?.modal]);

  const site = useMemo(() => {
    const sites = sitesQuery.data;
    if (!sites) return undefined;
    if (fabId) return sites.find((value) => value.fabs.some((fabValue) => fabValue.fabId === fabId));
    return sites.find((value) => value.siteId === siteId) ?? sites[0];
  }, [sitesQuery.data, siteId, fabId]);
  const selectedFabId = useMemo(() => fabId ?? site?.fabs[0]?.fabId, [fabId, site]);
  const fab = useMemo(
    () => site ? site.fabs.find((value) => value.fabId === selectedFabId) ?? site.fabs[0] : undefined,
    [site, selectedFabId],
  );

  useEffect(() => {
    if (site) document.title = `${site.code} / ${fab?.code ?? 'FAB'} · 3D FAB`;
  }, [site, fab]);

  return { site, fab, selectedFabId, statusSiteId: site?.siteId };
}
