import type { CatalogEntryDto } from '../../../contracts';
import type { CatalogDomain } from '../catalog-data';
import { createSliceStore } from '../../../state/createSliceStore';

export interface CatalogState {
  view: 'catalog' | 'compare';
  domain: CatalogDomain;
  category: string;
  query: string;
  hideDrafts: boolean;
  selected: string[];
  detailId?: string;
  page: number;
  localEntries: CatalogEntryDto[] | null;
  localImportId: string;
  importError: string;
  importRequestId?: string;
  importPending: boolean;
  hydrated: boolean;
}

export const initialCatalogState: CatalogState = {
  view: 'catalog',
  domain: 'ALL',
  category: '',
  query: '',
  hideDrafts: false,
  selected: [],
  page: 0,
  localEntries: null,
  localImportId: '',
  importError: '',
  importPending: false,
  hydrated: false,
};

const catalog = createSliceStore(initialCatalogState, {
  viewSet: (state, view: 'catalog' | 'compare') => ({ ...state, view }),
  domainSet: (state, domain: CatalogDomain) => ({ ...state, domain }),
  categorySet: (state, category: string) => ({ ...state, category }),
  querySet: (state, query: string) => ({ ...state, query }),
  hideDraftsSet: (state, hideDrafts: boolean) => ({ ...state, hideDrafts }),
  selectedSet: (state, selected: string[]) => ({ ...state, selected }),
  selectedToggled: (state, id: string) => {
    const selected = state.selected.includes(id)
      ? state.selected.filter((value) => value !== id)
      : state.selected.length < 4 ? [...state.selected, id] : state.selected;
    return { ...state, selected };
  },
  detailIdSet: (state, detailId?: string) => ({ ...state, detailId }),
  pageSet: (state, page: number) => ({ ...state, page: Math.max(0, page) }),
  importStarted: (state, requestId: string) => ({ ...state, importRequestId: requestId, importPending: true, importError: '' }),
  importFailed: (state, payload: { requestId: string; error: string }) => state.importRequestId !== payload.requestId
    ? state
    : { ...state, importError: payload.error, importPending: false },
  localImportApplied: (state, payload: { requestId: string; entries: CatalogEntryDto[]; importId: string }) => state.importRequestId !== payload.requestId
    ? state
    : {
        ...state,
        localEntries: payload.entries,
        localImportId: payload.importId,
        detailId: undefined,
        importError: '',
        page: 0,
        importPending: false,
      },
  localImportCleared: (state) => ({
    ...state,
    localEntries: null,
    localImportId: '',
    importError: '',
    importRequestId: undefined,
    importPending: false,
  }),
  hydrate: (state, patch: Partial<CatalogState>) => ({ ...state, ...patch, hydrated: true }),
});

export const useCatalogStore = catalog.useStore;
export const catalogActions = catalog.actions;
export const resetCatalogStore = catalog.reset;
