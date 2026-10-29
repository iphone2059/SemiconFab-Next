import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import type { MouseEvent } from 'react';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import type { RouterSearch } from '@/routes/route-search';
import { catalogActions } from '@/catalog/catalog.atom';
import { localeActions } from '@/state/locale.atom';
import { text } from '@/catalog/catalog-labels';
import type { CatalogView } from '@/catalog/catalog-types';
import { CatalogHeader } from '@/catalog/catalog-header';
import { CatalogFooter } from '@/catalog/catalog-footer';
import { CatalogToolbar } from '@/catalog/catalog-toolbar';
import { CatalogFilters } from '@/catalog/catalog-filters';
import { CatalogTable } from '@/catalog/catalog-table';
import { CatalogComparison } from '@/catalog/catalog-comparison';
import { EquipmentDetails } from '@/catalog/catalog-detail';
import { useCatalogData } from '@/catalog/use-catalog-data';
import { useCatalogRouteState } from '@/catalog/use-catalog-route-state';
import { useCatalogImport } from '@/catalog/use-catalog-import';
import { useCatalogDownloads } from '@/catalog/use-catalog-downloads';
import {
  CATALOG_EXPORT_FILENAME,
  catalogExportDocument,
  catalogRecordFilename,
} from '@/catalog/catalog-export';
import '../../assets/catalog.css';

export interface CatalogPageProps {
  view: CatalogView;
  /** Router-owned search state; the page never reads window.location for product state. */
  search: RouterSearch;
  onSearchChange: (patch: Partial<RouterSearch>, replace?: boolean) => void;
  onViewChange: (next: CatalogView, patch: Partial<RouterSearch>) => void;
}

/**
 * Route composition root. Data selection, URL coordination and the export
 * lifecycle are owned by the feature controllers/modules; this file only composes
 * the shell, the list/compare views and the detail dialog.
 */
export function CatalogPage({ view: initialView, search, onSearchChange, onViewChange }: CatalogPageProps) {
  const registry = useContext(RegistryContext);
  const data = useCatalogData();
  const route = useCatalogRouteState({
    initialView,
    search,
    onSearchChange,
    onViewChange,
    entries: data.entries,
  });
  const catalogImport = useCatalogImport();
  const downloads = useCatalogDownloads();
  const { preferences, language, view, openView, hrefFor, navigate } = route;
  const t = (zh: string, en: string) => text(language, zh, en);

  function toggle(id: string): void {
    catalogActions.selectedToggled(registry, id);
  }
  function selectDomain(domain: 'ALL' | 'FAB' | 'OSAT'): void {
    catalogActions.domainSet(registry, domain);
    catalogActions.categorySet(registry, '');
    catalogActions.pageSet(registry, 0);
  }
  function selectQuery(query: string): void {
    catalogActions.querySet(registry, query);
    catalogActions.pageSet(registry, 0);
  }
  function selectCategory(category: string): void {
    catalogActions.categorySet(registry, category);
    catalogActions.pageSet(registry, 0);
  }
  function selectHideDrafts(hideDrafts: boolean): void {
    catalogActions.hideDraftsSet(registry, hideDrafts);
    catalogActions.pageSet(registry, 0);
  }
  function exportCatalog(): void {
    downloads.downloadJson(
      catalogExportDocument(data.entries, {
        importId: data.importId,
        localPreview: data.localPreview,
      }),
      CATALOG_EXPORT_FILENAME,
    );
  }
  function downloadRecord(entry: CatalogEntryDto): void {
    downloads.downloadJson(entry.record, catalogRecordFilename(entry.recordId));
  }
  function navigateView(event: MouseEvent<HTMLAnchorElement>, next: CatalogView): void {
    navigate(event, next);
  }

  return (
    <div className="catalog-shell" data-theme={preferences.theme}>
      <CatalogHeader
        view={view}
        language={language}
        theme={preferences.theme}
        hrefFor={hrefFor}
        onNavigate={navigateView}
        onToggleLanguage={() => localeActions.languageToggled(registry)}
        onToggleTheme={() => localeActions.themeToggled(registry)}
      />
      <main className="catalog-main">
        <div className="catalog-heading">
          <div>
            <span className="catalog-eyebrow">EQUIPMENT INTELLIGENCE</span>
            <h1>
              {view === 'compare'
                ? t('让设备差异，清晰可见。', 'See how the tools compare.')
                : t('从设备开始，理解晶圆工厂。', 'Understand the fab, one tool at a time.')}
            </h1>
            <p>
              {t(
                '前道制造与封装测试设备 · 原始规格、字段来源与估算依据',
                'Front-end & OSAT equipment · Original specifications, provenance and estimates',
              )}
            </p>
          </div>
          <span className="catalog-total">
            <strong>{data.entries.length}</strong>
            {t('条设备记录', 'equipment records')}
          </span>
        </div>
        <div className="catalog-notice">
          {data.localPreview
            ? t(
                '本地预览：仅替换此页面显示，不会上传、批准或修改基地设备。',
                'Local preview: this page only. No upload, approval or Site equipment changes. Export JSON to share local data.',
              )
            : t(
                '迁移自原版设备库。L1 / draft 为历史标签；估价为带日期的参考区间。',
                'Migrated from the original catalog. L1 / draft are legacy labels; estimates are dated reference ranges.',
              )}
        </div>
        {data.error && (
          <div className="catalog-error" role="alert">
            {data.error}{' '}
            <button onClick={data.restoreServerCatalog}>
              {t('重新读取服务端目录', 'Reload server catalog')}
            </button>
          </div>
        )}
        {view === 'compare' && (
          <section className="catalog-section" aria-label={t('设备对比结果', 'Comparison results')}>
            <CatalogComparison entries={data.selectedEntries} language={language} onRemove={toggle} />
            {!data.loading &&
              data.missingIds.map((id) => (
                <p className="catalog-error" key={id}>
                  {t('目录中未找到：', 'Not found in catalog: ')}
                  {id} <button onClick={() => toggle(id)}>{t('移除', 'Remove')}</button>
                </p>
              ))}
          </section>
        )}
        <section className="catalog-section">
          <CatalogToolbar
            language={language}
            domain={data.domain}
            entriesCount={data.entries.length}
            localPreview={data.localPreview}
            onDomainChange={selectDomain}
            onImportFile={catalogImport.importFile}
            onExportCatalog={exportCatalog}
            onRestoreServer={data.restoreServerCatalog}
          />
          <CatalogFilters
            language={language}
            query={data.query}
            category={data.category}
            categories={data.categories}
            hideDrafts={data.hideDrafts}
            selectedCount={data.selected.length}
            onQueryChange={selectQuery}
            onCategoryChange={selectCategory}
            onHideDraftsChange={selectHideDrafts}
            onCompare={() => openView('compare')}
          />
          <CatalogTable
            language={language}
            loading={data.loading}
            error={data.error}
            entries={data.pageEntries}
            filteredCount={data.filtered.length}
            localPreview={data.localPreview}
            importId={data.importId}
            selected={data.selected}
            currentPage={data.currentPage}
            pageCount={data.pageCount}
            onToggle={toggle}
            onInspect={(id) => catalogActions.detailIdSet(registry, id)}
            onPageChange={(page) => catalogActions.pageSet(registry, page)}
          />
        </section>
        <CatalogFooter language={language} />
      </main>
      {data.detail && (
        <EquipmentDetails
          entry={data.detail}
          language={language}
          onClose={() => catalogActions.detailIdSet(registry, undefined)}
          onDownloadRecord={downloadRecord}
        />
      )}
    </div>
  );
}
