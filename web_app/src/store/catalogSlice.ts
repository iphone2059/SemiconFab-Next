import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { CatalogEntryDto } from '../contracts';
import type { CatalogDomain } from '../catalog-data';
import type { Preferences } from '../preferences';

export interface CatalogState {
  view: 'catalog' | 'compare';
  preferences: Preferences;
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
}
const initial: CatalogState = {
  view: 'catalog',
  preferences: { language: 'zh', theme: 'light' },
  domain: 'ALL',
  category: '',
  query: '',
  hideDrafts: false,
  selected: [],
  page: 0,
  localEntries: null,
  localImportId: '',
  importError: '',
};

export const catalogSlice = createSlice({
  name: 'catalog',
  initialState: initial,
  reducers: {
    viewSet(state, action: PayloadAction<'catalog' | 'compare'>) { state.view = action.payload; },
    preferencesSet(state, action: PayloadAction<Preferences>) { state.preferences = action.payload; },
    languageToggled(state) { state.preferences = { ...state.preferences, language: state.preferences.language === 'zh' ? 'en' : 'zh' }; },
    themeToggled(state) { state.preferences = { ...state.preferences, theme: state.preferences.theme === 'light' ? 'dark' : 'light' }; },
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
    localImportApplied(state, action: PayloadAction<{ entries: CatalogEntryDto[]; importId: string }>) {
      state.localEntries = action.payload.entries;
      state.localImportId = action.payload.importId;
      state.detailId = undefined;
      state.importError = '';
      state.page = 0;
    },
    localImportCleared(state) { state.localEntries = null; state.localImportId = ''; },
    importErrorSet(state, action: PayloadAction<string>) { state.importError = action.payload; },
    hydrate(state, action: PayloadAction<Partial<CatalogState>>) { Object.assign(state, action.payload); },
  },
});
export const catalogActions = catalogSlice.actions;
