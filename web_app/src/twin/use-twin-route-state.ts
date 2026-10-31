import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect } from 'react';
import type { FabDto, SiteDto } from '@/contracts/app-contracts';
import { findSiteFab, sitesDefinition } from '@/api/sites.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { searchToQueryString, type RouterSearch } from '@/routes/route-search';
import { languageTag, readPreferences } from '@/state/preferences.atom';
import { localeAtom } from '@/state/locale.atom';
import { twinPageAtom, twinPageActions } from '@/twin/twin-page.atom';
import { twinPageUiActions } from '@/twin/twin-page-ui.atom';
import { twinYmsActions } from '@/twin/twin-yms.atom';
import { twinUiAtom, twinUiActions } from '@/twin/twin-ui.atom';
import { stopTwinTourRuntime } from '@/twin/twin-tour-runtime';
import { stopTwinWaferRuntime } from '@/twin/twin-wafer-runtime';
import type { EntryMode } from '@/twin/twin-state';
import { ONBOARDING_KEY } from '@/twin/twin-page-data';
import type { TwinLanguage } from '@/twin/twin-i18n';
import { twinModalFrom, twinModeFrom, twinSiteIdFrom } from '@/twin/twin-search';

export interface TwinRouteStateParams {
  /** Canonical route siteId; with fabId it is the composite FAB identity (ADR-007 §3). */
  siteId?: string;
  fabId?: string;
  /** Page-store site fallback, used only when the route carries no identity (SSR, tests). */
  pageSiteId?: string;
  /** Router-owned search state; the page never reads window.location for product state. */
  search?: RouterSearch;
  onSearchChange?: (patch: Partial<RouterSearch>, replace?: boolean) => void;
  mode: EntryMode;
  language: TwinLanguage;
  theme: 'light' | 'dark';
  t: (text: string, parameters?: readonly unknown[]) => string;
}

export interface TwinRouteState {
  site?: SiteDto;
  fab?: FabDto;
  /** Exact selected FAB id; never a cross-site first match. */
  selectedFabId?: string;
}

interface TwinRouteResolution {
  site?: SiteDto;
  fab?: FabDto;
  selectedFabId?: string;
  error?: string;
}

/**
 * Resolves the composite route identity against the configured sites document.
 *
 * - siteId + fabId: EXACT membership. A missing site or a FAB that is not in
 *   that site is an error; there is no first-match across sites.
 * - siteId only: exact site; its first configured FAB is the explicit default
 *   selection (a Site has 1..32 independent FABs).
 * - neither: the pre-existing page-store / legacy ?siteId= / first-site fallback.
 * - fabId without siteId: scoped to the page-store/legacy site only; it must
 *   never first-match a site from the FAB id alone.
 */
function resolveTwinRoute(
  sites: readonly SiteDto[],
  identity: { siteId?: string; fabId?: string },
  fallbackSiteId: string | undefined,
  t: TwinRouteStateParams['t'],
): TwinRouteResolution {
  const { siteId, fabId } = identity;
  if (siteId !== undefined) {
    const site = sites.find((value) => value.siteId === siteId);
    if (!site) return { error: t('指定的 FAB 站点不存在：{0}', [siteId]) };
    if (fabId !== undefined) {
      const resolved = findSiteFab(sites, { siteId, fabId });
      if (!resolved) return { error: t('指定的 FAB 不存在：{0}', [fabId]) };
      return { site: resolved.site, fab: resolved.fab, selectedFabId: resolved.fab.fabId };
    }
    const fab = site.fabs[0];
    return { site, fab, selectedFabId: fab?.fabId };
  }
  if (fabId !== undefined) {
    const scoped = fallbackSiteId === undefined ? undefined : sites.find((value) => value.siteId === fallbackSiteId);
    if (!scoped) return { error: t('无法解析 FAB 站点：{0}', [fabId]) };
    const resolved = findSiteFab(sites, { siteId: scoped.siteId, fabId });
    if (!resolved) return { error: t('指定的 FAB 不存在：{0}', [fabId]) };
    return { site: resolved.site, fab: resolved.fab, selectedFabId: resolved.fab.fabId };
  }
  const fallback = fallbackSiteId === undefined ? undefined : sites.find((value) => value.siteId === fallbackSiteId);
  const site = fallback ?? sites[0];
  if (!site) return { error: t('没有可用的 FAB 站点') };
  const fab = site.fabs[0];
  return { site, fab, selectedFabId: fab?.fabId };
}

/**
 * URL <-> store synchronization for the Twin page.
 *
 * The router search object is the owner of every persisted/deep-linked value
 * (mode, language, theme, legacy ?siteId= compatibility, modal deep links). This
 * hook mirrors it into the UI/locale/page stores and writes user changes back
 * through the router callback; nothing here touches history/location directly.
 * It also resolves the composite route identity into the site/fab projection the
 * page renders (no site inference from a bare fabId).
 */
export function useTwinRouteState({
  siteId,
  fabId,
  pageSiteId,
  search,
  onSearchChange,
  mode,
  language,
  theme,
  t,
}: TwinRouteStateParams): TwinRouteState {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const sitesView = useResource(appRuntime, sitesDefinition);
  const searchQuery = searchToQueryString(search ?? {});
  const searchMode = search?.mode;
  const searchLang = search?.lang;
  const searchTheme = search?.theme;
  const routeModal = twinModalFrom(search ?? {});
  const legacySiteId = twinSiteIdFrom(search ?? {});
  const fallbackSiteId = legacySiteId ?? pageSiteId;
  const sitesData = sitesView.data;
  const resolution: TwinRouteResolution = sitesData === undefined
    ? {}
    : resolveTwinRoute(sitesData, { siteId, fabId }, fallbackSiteId, t);
  const resolvedSiteId = resolution.site?.siteId;
  const resolvedError = resolution.error;

  // URL is the owner of persisted language/theme overrides; the store is synced
  // from the router search and writes back through it (no history/location use).
  useEffect(() => {
    try {
      registry.set(localeAtom, readPreferences(localStorage, searchQuery));
    } catch {
      /* Storage denial must not prevent opening the FAB. */
    }
  }, [searchQuery, registry]);

  useEffect(() => {
    const requested = twinModeFrom(searchMode === undefined ? {} : { mode: searchMode });
    if (requested && registry.get(twinUiAtom).entryMode !== requested) {
      if (requested !== 'visitor') stopTwinTourRuntime(registry);
      stopTwinWaferRuntime(registry);
      twinUiActions.modeSet(registry, requested);
    }
  }, [searchMode, registry]);

  useEffect(() => {
    if (registry.get(twinUiAtom).entryMode !== mode) return;
    if (searchMode !== mode) onSearchChange?.({ mode }, true);
  }, [mode, onSearchChange, searchMode, registry]);

  useEffect(() => {
    const current = registry.get(localeAtom);
    if (current.language !== language || current.theme !== theme) return;
    const lang = languageTag(language);
    if (searchLang !== lang || searchTheme !== theme) onSearchChange?.({ lang, theme }, true);
  }, [language, theme, onSearchChange, searchLang, searchTheme, registry]);

  useEffect(() => {
    if (sitesData === undefined) return;
    if (resolvedError !== undefined) {
      twinPageActions.siteErrorSet(registry, resolvedError);
      return;
    }
    if (resolvedSiteId === undefined) return;
    if (registry.get(twinPageAtom).siteId !== resolvedSiteId) twinPageActions.siteIdSet(registry, resolvedSiteId);
    if (registry.get(twinPageAtom).siteError !== undefined) twinPageActions.siteErrorSet(registry, undefined);
  }, [sitesData, resolvedSiteId, resolvedError, registry]);

  useEffect(() => {
    if (sitesView.error === undefined) return;
    twinPageActions.siteErrorSet(registry, t('FAB 数据加载失败'));
  }, [sitesView.error, t, registry]);

  useEffect(() => {
    if (routeModal === 'database' || routeModal === 'catalog') twinPageUiActions.infoDialogSet(registry, 'database');
    else if (routeModal === 'arch') twinPageUiActions.infoDialogSet(registry, 'architecture');
    else if (routeModal === 'yms') { twinYmsActions.ymsOpenSet(registry, true); twinYmsActions.ymsTabSet(registry, 'map'); }
  }, [routeModal, registry]);

  useEffect(() => {
    try {
      if (!routeModal && localStorage.getItem(ONBOARDING_KEY) !== '1') {
        stopTwinTourRuntime(registry);
        stopTwinWaferRuntime(registry);
        twinUiActions.onboardingOpen(registry);
      }
    } catch {
      // Storage may be blocked; the page still works without onboarding memory.
    }
  }, [routeModal, registry]);

  const { site, fab, selectedFabId } = resolution;

  useEffect(() => {
    if (site) document.title = `${site.code} / ${fab?.code ?? 'FAB'} · 3D FAB`;
  }, [site, fab, registry]);

  return { site, fab, selectedFabId };
}
