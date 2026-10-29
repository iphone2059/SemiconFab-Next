import type { PickedTool, SceneLayer } from '@/contracts/scene.port';
import type { TwinSelection } from '@/domain/original-twin-data';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * Twin page UI overlays and preferences.
 *
 * Owner: user interaction (pointer/click/keyboard handlers, dialogs, sidebar).
 * Split from the former single TwinPageState so FAB-scoped server frames do not
 * notify the overlay subtree and overlay edits do not notify the FAB projection.
 * Per-field updates are rare and shallow; values keep stable references so
 * selector subscriptions only rerender the node that actually changed.
 */
export type TwinSidebarState = {
  tab: 'fab' | 'oem';
  query: string;
  category: string;
  segment: string;
  stateFilter: string;
  switched: boolean;
};

export interface TwinPageUiState {
  selected?: PickedTool;
  selection?: TwinSelection;
  layerPreferences: Record<SceneLayer, boolean>;
  infoDialog: 'architecture' | 'database' | null;
  showResearchUtil: boolean;
  onboardingDontShow: boolean;
  sidebar: TwinSidebarState;
  oemDialog: { query: string; segment: string; vendor: string };
  archQuery: string;
}

export const initialTwinPageUiState: TwinPageUiState = {
  layerPreferences: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false },
  infoDialog: null,
  showResearchUtil: true,
  onboardingDontShow: true,
  sidebar: { tab: 'fab', query: '', category: 'ALL', segment: 'ALL', stateFilter: 'ALL', switched: false },
  oemDialog: { query: '', segment: 'ALL', vendor: 'ALL' },
  archQuery: '',
};

const pageUi = (state: TwinPageUiState, patch: Partial<TwinPageUiState>): TwinPageUiState => ({ ...state, ...patch });
const sidebar = (state: TwinPageUiState, patch: Partial<TwinSidebarState>): TwinPageUiState => pageUi(state, { sidebar: { ...state.sidebar, ...patch } });
const oemDialog = (state: TwinPageUiState, patch: Partial<TwinPageUiState['oemDialog']>): TwinPageUiState => pageUi(state, { oemDialog: { ...state.oemDialog, ...patch } });

const reducers = {
  selectedSet: (state: TwinPageUiState, selected?: PickedTool) => pageUi(state, { selected }),
  selectionSet: (state: TwinPageUiState, selection?: TwinSelection) => pageUi(state, { selection }),
  layerToggled: (state: TwinPageUiState, layer: SceneLayer) => pageUi(state, { layerPreferences: { ...state.layerPreferences, [layer]: !state.layerPreferences[layer] } }),
  infoDialogSet: (state: TwinPageUiState, infoDialog: 'architecture' | 'database' | null) => pageUi(state, { infoDialog }),
  showResearchUtilToggled: (state: TwinPageUiState) => pageUi(state, { showResearchUtil: !state.showResearchUtil }),
  onboardingDontShowSet: (state: TwinPageUiState, onboardingDontShow: boolean) => pageUi(state, { onboardingDontShow }),
  sidebarTabSet: (state: TwinPageUiState, tab: 'fab' | 'oem') => sidebar(state, { tab, query: '', segment: 'ALL', switched: true }),
  sidebarQuerySet: (state: TwinPageUiState, query: string) => sidebar(state, { query }),
  sidebarCategorySet: (state: TwinPageUiState, category: string) => sidebar(state, { category }),
  sidebarSegmentSet: (state: TwinPageUiState, segment: string) => sidebar(state, { segment }),
  sidebarStateFilterToggle: (state: TwinPageUiState, stateFilter: string) => sidebar(state, {
    stateFilter: state.sidebar.stateFilter === stateFilter ? 'ALL' : stateFilter,
  }),
  oemDialogQuerySet: (state: TwinPageUiState, query: string) => oemDialog(state, { query }),
  oemDialogSegmentSet: (state: TwinPageUiState, segment: string) => oemDialog(state, { segment }),
  oemDialogVendorSet: (state: TwinPageUiState, vendor: string) => oemDialog(state, { vendor }),
  archQuerySet: (state: TwinPageUiState, query: string) => pageUi(state, { archQuery: query }),
};

export const twinPageUiAtom = Atom.make<TwinPageUiState>(initialTwinPageUiState).pipe(Atom.keepAlive);

export const twinPageUiActions = {
  selectedSet: (registry: AtomRegistry.AtomRegistry, selected?: PickedTool): void => {
    registry.update(twinPageUiAtom, state => reducers.selectedSet(state, selected));
  },
  selectionSet: (registry: AtomRegistry.AtomRegistry, selection?: TwinSelection): void => {
    registry.update(twinPageUiAtom, state => reducers.selectionSet(state, selection));
  },
  layerToggled: (registry: AtomRegistry.AtomRegistry, layer: SceneLayer): void => {
    registry.update(twinPageUiAtom, state => reducers.layerToggled(state, layer));
  },
  infoDialogSet: (registry: AtomRegistry.AtomRegistry, infoDialog: 'architecture' | 'database' | null): void => {
    registry.update(twinPageUiAtom, state => reducers.infoDialogSet(state, infoDialog));
  },
  showResearchUtilToggled: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(twinPageUiAtom, state => reducers.showResearchUtilToggled(state));
  },
  onboardingDontShowSet: (registry: AtomRegistry.AtomRegistry, onboardingDontShow: boolean): void => {
    registry.update(twinPageUiAtom, state => reducers.onboardingDontShowSet(state, onboardingDontShow));
  },
  sidebarTabSet: (registry: AtomRegistry.AtomRegistry, tab: 'fab' | 'oem'): void => {
    registry.update(twinPageUiAtom, state => reducers.sidebarTabSet(state, tab));
  },
  sidebarQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageUiAtom, state => reducers.sidebarQuerySet(state, query));
  },
  sidebarCategorySet: (registry: AtomRegistry.AtomRegistry, category: string): void => {
    registry.update(twinPageUiAtom, state => reducers.sidebarCategorySet(state, category));
  },
  sidebarSegmentSet: (registry: AtomRegistry.AtomRegistry, segment: string): void => {
    registry.update(twinPageUiAtom, state => reducers.sidebarSegmentSet(state, segment));
  },
  sidebarStateFilterToggle: (registry: AtomRegistry.AtomRegistry, stateFilter: string): void => {
    registry.update(twinPageUiAtom, state => reducers.sidebarStateFilterToggle(state, stateFilter));
  },
  oemDialogQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageUiAtom, state => reducers.oemDialogQuerySet(state, query));
  },
  oemDialogSegmentSet: (registry: AtomRegistry.AtomRegistry, segment: string): void => {
    registry.update(twinPageUiAtom, state => reducers.oemDialogSegmentSet(state, segment));
  },
  oemDialogVendorSet: (registry: AtomRegistry.AtomRegistry, vendor: string): void => {
    registry.update(twinPageUiAtom, state => reducers.oemDialogVendorSet(state, vendor));
  },
  archQuerySet: (registry: AtomRegistry.AtomRegistry, query: string): void => {
    registry.update(twinPageUiAtom, state => reducers.archQuerySet(state, query));
  },
};
