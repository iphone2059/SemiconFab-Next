import type { CatalogEntryDto } from '../contracts';
import type { CatalogDomain } from '../catalog-data';
import { createSliceStore } from './createSliceStore';

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
  viewSet: (state, action) => ({ ...state, view: action.payload }),
  domainSet: (state, action) => ({ ...state, domain: action.payload }),
  categorySet: (state, action) => ({ ...state, category: action.payload }),
  querySet: (state, action) => ({ ...state, query: action.payload }),
  hideDraftsSet: (state, action) => ({ ...state, hideDrafts: action.payload }),
  selectedSet: (state, action) => ({ ...state, selected: action.payload }),
  selectedToggled: (state, action) => {
    const id = action.payload as string;
    const selected = state.selected.includes(id)
      ? state.selected.filter((value) => value !== id)
      : state.selected.length < 4 ? [...state.selected, id] : state.selected;
    return { ...state, selected };
  },
  detailIdSet: (state, action) => ({ ...state, detailId: action.payload }),
  pageSet: (state, action) => ({ ...state, page: Math.max(0, action.payload) }),
  importStarted: (state, action) => ({ ...state, importRequestId: action.payload, importPending: true, importError: '' }),
  importFailed: (state, action) => state.importRequestId !== action.payload.requestId
    ? state
    : { ...state, importError: action.payload.error, importPending: false },
  localImportApplied: (state, action) => state.importRequestId !== action.payload.requestId
    ? state
    : {
        ...state,
        localEntries: action.payload.entries,
        localImportId: action.payload.importId,
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
  hydrate: (state, action) => ({ ...state, ...action.payload, hydrated: true }),
});

export const useCatalogStore = catalog.useStore;
export const catalogActions = catalog.actions as {
  viewSet: (view: 'catalog' | 'compare') => void;
  domainSet: (domain: CatalogDomain) => void;
  categorySet: (category: string) => void;
  querySet: (query: string) => void;
  hideDraftsSet: (hide: boolean) => void;
  selectedSet: (ids: string[]) => void;
  selectedToggled: (id: string) => void;
  detailIdSet: (id?: string) => void;
  pageSet: (page: number) => void;
  importStarted: (requestId: string) => void;
  importFailed: (payload: { requestId: string; error: string }) => void;
  localImportApplied: (payload: { requestId: string; entries: CatalogEntryDto[]; importId: string }) => void;
  localImportCleared: () => void;
  hydrate: (state: Partial<CatalogState>) => void;
};
export const resetCatalogStore = catalog.reset;
