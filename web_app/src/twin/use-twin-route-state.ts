import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect } from 'react';
import type { FabDto, SiteDto } from '@/contracts/app-contracts';
import { sitesResource } from '@/api/sites.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { searchToQueryString, type RouterSearch } from '@/routes/route-search';
import { languageTag, readPreferences } from '@/state/preferences.atom';
import { localeAtom } from '@/state/locale.atom';
import { twinPageAtom, twinPageActions } from '@/twin/twin-page.atom';
import { twinUiAtom, twinUiActions } from '@/twin/twin-ui.atom';
import type { EntryMode } from '@/twin/twin-state';
import { ONBOARDING_KEY } from '@/twin/twin-page-data';
import type { TwinLanguage } from '@/twin/twin-i18n';
import { twinModalFrom, twinModeFrom, twinSiteIdFrom } from '@/twin/twin-search';

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
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const sitesView = useResource(appRuntime, sitesResource);
  const searchQuery = searchToQueryString(search ?? {});
  const searchMode = search?.mode;
  const searchLang = search?.lang;
  const searchTheme = search?.theme;
  const routeModal = twinModalFrom(search ?? {});
  const legacySiteId = twinSiteIdFrom(search ?? {});

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
    if (requested && registry.get(twinUiAtom).entryMode !== requested) twinUiActions.modeSet(registry, requested);
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
    if (!sitesView.data) return;
    // Canonical route identity (/fabs/$fabId/3d) wins over the transitional
    // ?siteId= compatibility parameter; the legacy parameter is still honoured
    // when the route does not carry a FAB id.
    let next: SiteDto | undefined;
    if (fabId) {
      next = sitesView.data.find((value) => value.fabs.some((fabValue) => fabValue.fabId === fabId));
      if (!next) {
        twinPageActions.siteErrorSet(registry, t("指定的 FAB 不存在：{0}", [fabId]));
        return;
      }
    } else if (siteId) {
      return;
    } else {
      next = legacySiteId ? sitesView.data.find((value) => value.siteId === legacySiteId) : sitesView.data[0];
      if (!next) {
        twinPageActions.siteErrorSet(registry, legacySiteId ? t("指定的 FAB 站点不存在：{0}", [legacySiteId]) : t("没有可用的 FAB 站点"));
        return;
      }
    }
    // Multiple FABs are a first-class product shape: the route/first-FAB fallback
    // selects one FAB, it never rejects the site for having more than one.
    if (registry.get(twinPageAtom).siteId !== next.siteId) twinPageActions.siteIdSet(registry, next.siteId);
    if (registry.get(twinPageAtom).siteError !== undefined) twinPageActions.siteErrorSet(registry, undefined);
  }, [sitesView.data, siteId, fabId, legacySiteId, t, registry, sitesView.error]);

  useEffect(() => {
    if (sitesView.error === undefined) return;
    twinPageActions.siteErrorSet(registry, t('FAB 数据加载失败'));
  }, [sitesView.error, t, registry]);

  useEffect(() => {
    if (routeModal === 'database' || routeModal === 'catalog') twinPageActions.infoDialogSet(registry, 'database');
    else if (routeModal === 'arch') twinPageActions.infoDialogSet(registry, 'architecture');
    else if (routeModal === 'yms') { twinPageActions.ymsOpenSet(registry, true); twinPageActions.ymsTabSet(registry, 'map'); }
  }, [routeModal, registry]);

  useEffect(() => {
    try {
      if (!routeModal && localStorage.getItem(ONBOARDING_KEY) !== '1') twinUiActions.onboardingOpen(registry);
    } catch {
      // Storage may be blocked; the page still works without onboarding memory.
    }
  }, [routeModal, registry]);

  const sitesData = sitesView.data;
  const site = !sitesData
    ? undefined
    : fabId
      ? sitesData.find((value) => value.fabs.some((fabValue) => fabValue.fabId === fabId))
      : sitesData.find((value) => value.siteId === siteId) ?? sitesData[0];
  const selectedFabId = (fabId ?? site?.fabs[0]?.fabId);
  const fab = (site ? site.fabs.find((value) => value.fabId === selectedFabId) ?? site.fabs[0] : undefined);

  useEffect(() => {
    if (site) document.title = `${site.code} / ${fab?.code ?? 'FAB'} · 3D FAB`;
  }, [site, fab, registry]);

  return { site, fab, selectedFabId, statusSiteId: site?.siteId };
}
