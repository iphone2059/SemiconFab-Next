import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useDeferredValue } from 'react';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { catalogResource } from '@/api/catalog.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { filterCatalog, type CatalogDomain } from '@/catalog/catalog-data';
import { catalogActions, catalogAtom } from '@/catalog/catalog.atom';

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
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const catalogView = useResource(appRuntime, catalogResource);
  const catalogState = useAtomValue(catalogAtom);
  const {
    domain, category, query, hideDrafts, selected,
    detailId, page, localEntries, localImportId, importError,
  } = catalogState;
  // Network entries were validated by the catalog Query schema before caching.
  // Only local uploads require parseCatalogEntries at their import boundary.
  const entries = (localEntries ?? catalogView.data?.items ?? []);
  const importId = localEntries ? localImportId : (catalogView.data?.importId ?? '');
  const localPreview = localEntries !== null;
  const error = importError || (catalogView.error !== undefined ? 'Catalog request failed' : '');
  const loading = catalogView.isInitial && !localEntries;
  const detail = entries.find((entry) => entry.recordId === detailId);
  const deferredQuery = useDeferredValue(query);
  const filtered = (filterCatalog(entries, domain, category, deferredQuery, hideDrafts));
  const categories = ([
        ...new Set(
          entries
            .filter((entry) => domain === 'ALL' || entry.domain === domain)
            .map((entry) => entry.category),
        ),
      ].sort());
  const selectedEntries = (selected.flatMap((id) => {
        const entry = entries.find((item) => item.recordId === id);
        return entry ? [entry] : [];
      }));
  const missingIds = selected.filter((id) => !entries.some((entry) => entry.recordId === id));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEntries = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function restoreServerCatalog(): void {
    catalogActions.localImportCleared(registry);
    catalogView.refresh();
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
