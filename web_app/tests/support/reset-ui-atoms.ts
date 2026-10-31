import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { runtimeAtom, initialRuntimeState } from '@/state/runtime.atom';
import { viewerHoverAtom, viewerSelectionSyncAtom, viewerSessionAtom, initialViewerSession } from '@/state/viewer.atom';
import { localeAtom, initialLocale } from '@/state/locale.atom';
import { catalogAtom, initialCatalogState } from '@/catalog/catalog.atom';
import { workbenchAtom, initialWorkbenchState } from '@/workbench/workbench.atom';
import { twinPageAtom, initialTwinFabState } from '@/twin/twin-page.atom';
import { twinPageUiAtom, initialTwinPageUiState } from '@/twin/twin-page-ui.atom';
import { twinWaferAtom, initialTwinWaferProjection } from '@/twin/twin-wafer.atom';
import { twinYmsAtom, initialYmsUiState } from '@/twin/twin-yms.atom';
import { twinAmhsAtom } from '@/twin/twin-amhs.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { twinTourAtom, initialTwinTourProjection } from '@/twin/twin-tour.atom';
import { twinDemoAtom } from '@/twin/twin-demo.atom';
import { createTwinUiState } from '@/twin/twin-state';
import { createDemoState } from '@/domain/simulation-twin-equipment';

// Reset fixtures live with the tests; feature modules expose no test lifecycle API.
export const resetRuntimeState = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(runtimeAtom, structuredClone(initialRuntimeState));
  registry.set(viewerSessionAtom, structuredClone(initialViewerSession));
  registry.set(viewerHoverAtom, undefined);
  registry.set(viewerSelectionSyncAtom, undefined);
};
export const resetLocaleState = (registry: AtomRegistry.AtomRegistry) => registry.set(localeAtom, initialLocale());
export const resetCatalogState = (registry: AtomRegistry.AtomRegistry) => registry.set(catalogAtom, structuredClone(initialCatalogState));
export const resetWorkbenchState = (registry: AtomRegistry.AtomRegistry) => registry.set(workbenchAtom, structuredClone(initialWorkbenchState));
/** Resets every Twin page atom (FAB session, page UI, wafer projection, YMS and AMHS). */
export const resetTwinPageState = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(twinPageAtom, structuredClone(initialTwinFabState));
  registry.set(twinPageUiAtom, structuredClone(initialTwinPageUiState));
  registry.set(twinWaferAtom, structuredClone(initialTwinWaferProjection));
  registry.set(twinYmsAtom, structuredClone(initialYmsUiState));
  registry.set(twinAmhsAtom, undefined);
};
export const resetTwinUiState = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(twinUiAtom, createTwinUiState('engineer'));
  registry.set(twinTourAtom, initialTwinTourProjection);
};
export const resetTwinDemoState = (registry: AtomRegistry.AtomRegistry) => registry.set(twinDemoAtom, createDemoState(42));
