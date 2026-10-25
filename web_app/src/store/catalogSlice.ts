import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { CatalogEntryDto } from '../contracts';
import type { CatalogDomain } from '../catalog-data';

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
const initial: CatalogState = {
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

export const catalogSlice = createSlice({
  name: 'catalog',
  initialState: initial,
  reducers: {
    viewSet(state, action: PayloadAction<'catalog' | 'compare'>) { state.view = action.payload; },
    domainSet(state, action: PayloadAction<CatalogDomain>) { state.domain = action.payload; },
    categorySet(state, action: PayloadAction<string>) { state.category = action.payload; },
    querySet(state, action: PayloadAction<string>) { state.query = action.payload; },
    hideDraftsSet(state, action: PayloadAction<boolean>) { state.hideDrafts = action.payload; },
    selectedSet(state, action: PayloadAction<string[]>) { state.selected = action.payload; },
    selectedToggled(state, action: PayloadAction<string>) {
      const id = action.payload;
      state.selected = state.selected.includes(id)
        ? state.selected.filter((value) => value !== id)
        : state.selected.length < 4 ? [...state.selected, id] : state.selected;
    },
    detailIdSet(state, action: PayloadAction<string | undefined>) { state.detailId = action.payload; },
    pageSet(state, action: PayloadAction<number>) { state.page = Math.max(0, action.payload); },
    importStarted(state, action: PayloadAction<string>) { state.importRequestId = action.payload; state.importPending = true; state.importError = ''; },
    importFailed(state, action: PayloadAction<{ requestId: string; error: string }>) {
      if (state.importRequestId !== action.payload.requestId) return;
      state.importError = action.payload.error;
      state.importPending = false;
    },
    localImportApplied(state, action: PayloadAction<{ requestId: string; entries: CatalogEntryDto[]; importId: string }>) {
      if (state.importRequestId !== action.payload.requestId) return;
      state.localEntries = action.payload.entries;
      state.localImportId = action.payload.importId;
      state.detailId = undefined;
      state.importError = '';
      state.page = 0;
      state.importPending = false;
    },
    localImportCleared(state) {
      state.localEntries = null; state.localImportId = ''; state.importError = '';
      state.importRequestId = undefined; state.importPending = false;
    },
    hydrate(state, action: PayloadAction<Partial<CatalogState>>) { Object.assign(state, action.payload); state.hydrated = true; },
  },
});
export const catalogActions = catalogSlice.actions;
