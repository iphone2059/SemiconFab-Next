import { useDeferredValue, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CatalogEntryDto } from '../../../contracts';
import { catalogQueryOptions } from '../../../api/queries/catalog.queries';
import { filterCatalog, parseCatalogEntries, type CatalogDomain } from '../catalog-data';
import { catalogActions, useCatalogStore } from '../state/catalogStore';

const PAGE_SIZE = 40;

/** Everything the catalog list/compare views derive from server + local data. */
export interface CatalogDataSelection {
  domain: CatalogDomain;
  category: string;
  query: string;
  hideDrafts: boolean;
  selected: readonly string[];
  entries: readonly CatalogEntryDto[];
  importId: string;
  localPreview: boolean;
  error: string;
  loading: boolean;
  detail?: CatalogEntryDto;
  filtered: readonly CatalogEntryDto[];
  pageEntries: readonly CatalogEntryDto[];
  categories: readonly string[];
  selectedEntries: readonly CatalogEntryDto[];
  missingIds: readonly string[];
  pageCount: number;
  currentPage: number;
  restoreServerCatalog: () => void;
}

/**
 * Data-selection controller: TanStack Query remains the only server-snapshot
 * cache; the local preview entries and the Catalog representation parsing sit
 * between the raw Equipment Reference payload and the rendered views.
 */
export function useCatalogData(): CatalogDataSelection {
  const catalogState = useCatalogStore();
  const {
    domain, category, query, hideDrafts, selected,
    detailId, page, localEntries, localImportId, importError,
  } = catalogState;
  const catalogQuery = useQuery(catalogQueryOptions());
  const entries = useMemo(
    () =>
      localEntries ??
      (catalogQuery.data ? parseCatalogEntries({ entries: catalogQuery.data.items }) : []),
    [localEntries, catalogQuery.data],
  );
  const importId = localEntries ? localImportId : (catalogQuery.data?.importId ?? '');
  const localPreview = localEntries !== null;
  const error = importError || (catalogQuery.error instanceof Error ? 'Catalog request failed' : '');
  const loading = catalogQuery.isLoading && !localEntries;
  const detail = entries.find((entry) => entry.recordId === detailId);
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () => filterCatalog(entries, domain, category, deferredQuery, hideDrafts),
    [entries, domain, category, deferredQuery, hideDrafts],
  );
  const categories = useMemo(
    () =>
      [
        ...new Set(
          entries
            .filter((entry) => domain === 'ALL' || entry.domain === domain)
            .map((entry) => entry.category),
        ),
      ].sort(),
    [entries, domain],
  );
  const selectedEntries = useMemo(
    () =>
      selected.flatMap((id) => {
        const entry = entries.find((item) => item.recordId === id);
        return entry ? [entry] : [];
      }),
    [selected, entries],
  );
  const missingIds = selected.filter((id) => !entries.some((entry) => entry.recordId === id));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEntries = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function restoreServerCatalog(): void {
    catalogActions.localImportCleared();
    void catalogQuery.refetch();
  }

  return {
    domain,
    category,
    query,
    hideDrafts,
    selected,
    entries,
    importId,
    localPreview,
    error,
    loading,
    detail,
    filtered,
    pageEntries,
    categories,
    selectedEntries,
    missingIds,
    pageCount,
    currentPage,
    restoreServerCatalog,
  };
}
