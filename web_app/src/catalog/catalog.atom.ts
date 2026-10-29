import type { CatalogEntryDto } from '@/contracts/app-contracts';
import type { CatalogDomain } from '@/catalog/catalog-data';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

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

const reducers = {
  viewSet: (state: CatalogState, view: 'catalog' | 'compare') => ({ ...state, view }),
  domainSet: (state: CatalogState, domain: CatalogDomain) => ({ ...state, domain }),
  categorySet: (state: CatalogState, category: string) => ({ ...state, category }),
  querySet: (state: CatalogState, query: string) => ({ ...state, query }),
  hideDraftsSet: (state: CatalogState, hideDrafts: boolean) => ({ ...state, hideDrafts }),
  selectedSet: (state: CatalogState, selected: string[]) => ({ ...state, selected }),
  selectedToggled: (state: CatalogState, id: string) => {
    const selected = state.selected.includes(id)
      ? state.selected.filter((value) => value !== id)
      : state.selected.length < 4 ? [...state.selected, id] : state.selected;
    return { ...state, selected };
  },
  detailIdSet: (state: CatalogState, detailId?: string) => ({ ...state, detailId }),
  pageSet: (state: CatalogState, page: number) => ({ ...state, page: Math.max(0, page) }),
  importStarted: (state: CatalogState, requestId: string) => ({ ...state, importRequestId: requestId, importPending: true, importError: '' }),
  importFailed: (state: CatalogState, payload: { requestId: string; error: string }) => state.importRequestId !== payload.requestId
    ? state
    : { ...state, importError: payload.error, importPending: false },
  localImportApplied: (state: CatalogState, payload: { requestId: string; entries: CatalogEntryDto[]; importId: string }) => state.importRequestId !== payload.requestId
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
  localImportCleared: (state: CatalogState) => ({
    ...state,
    localEntries: null,
    localImportId: '',
    importError: '',
    importRequestId: undefined,
    importPending: false,
  }),
  hydrate: (state: CatalogState, patch: Partial<CatalogState>) => ({ ...state, ...patch, hydrated: true }),
};

export const catalogAtom = Atom.make<CatalogState>(initialCatalogState).pipe(Atom.keepAlive);

export const catalogActions = {
  viewSet: (registry: AtomRegistry.AtomRegistry, view: 'catalog' | 'compare'): void => {
    registry.update(catalogAtom, state => reducers.viewSet(state, view));
  },
  domainSet: (registry: AtomRegistry.AtomRegistry, domain: CatalogDomain): void => {
    registry.update(catalogAtom, state => reducers.domainSet(state, domain));
  },
  categorySet: (registry: AtomRegistry.AtomRegistry, category: string): void => {
    registry.update(catalogAtom, state => reducers.categorySet(state, category));
  },
  querySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(catalogAtom, state => reducers.querySet(state, query));
  },
  hideDraftsSet: (registry: AtomRegistry.AtomRegistry, hideDrafts: boolean): void => {
    registry.update(catalogAtom, state => reducers.hideDraftsSet(state, hideDrafts));
  },
  selectedSet: (registry: AtomRegistry.AtomRegistry, selected: string[]): void => {
    registry.update(catalogAtom, state => reducers.selectedSet(state, selected));
  },
  selectedToggled: (registry: AtomRegistry.AtomRegistry, id: string): void => {
    registry.update(catalogAtom, state => reducers.selectedToggled(state, id));
  },
  detailIdSet: (registry: AtomRegistry.AtomRegistry, detailId?: string): void => {
    registry.update(catalogAtom, state => reducers.detailIdSet(state, detailId));
  },
  pageSet: (registry: AtomRegistry.AtomRegistry, page: number): void => {
    registry.update(catalogAtom, state => reducers.pageSet(state, page));
  },
  importStarted: (registry: AtomRegistry.AtomRegistry, requestId: string): void => {
    registry.update(catalogAtom, state => reducers.importStarted(state, requestId));
  },
  importFailed: (registry: AtomRegistry.AtomRegistry, payload: { requestId: string; error: string }): void => {
    registry.update(catalogAtom, state => reducers.importFailed(state, payload));
  },
  localImportApplied: (registry: AtomRegistry.AtomRegistry, payload: { requestId: string; entries: CatalogEntryDto[]; importId: string }): void => {
    registry.update(catalogAtom, state => reducers.localImportApplied(state, payload));
  },
  localImportCleared: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(catalogAtom, state => reducers.localImportCleared(state));
  },
  hydrate: (registry: AtomRegistry.AtomRegistry, patch: Partial<CatalogState>): void => {
    registry.update(catalogAtom, state => reducers.hydrate(state, patch));
  },
};
