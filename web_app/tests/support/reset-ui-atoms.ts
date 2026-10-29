import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { runtimeAtom, initialRuntimeState } from '@/state/runtime-store';
import { localeAtom, initialLocale } from '@/state/locale.atom';
import { catalogAtom, initialCatalogState } from '@/catalog/catalog.atom';
import { workbenchAtom, initialWorkbenchState } from '@/workbench/workbench.atom';
import { twinPageAtom, initialTwinPageState } from '@/twin/twin-page.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { twinDemoAtom } from '@/twin/twin-demo.atom';
import { createTwinUiState } from '@/twin/twin-state';
import { createDemoState } from '@/domain/simulation-twin-equipment';

// Reset fixtures live with the tests; feature modules expose no test lifecycle API.
export const resetRuntimeState = (registry: AtomRegistry.AtomRegistry) => registry.set(runtimeAtom, structuredClone(initialRuntimeState));
export const resetLocaleState = (registry: AtomRegistry.AtomRegistry) => registry.set(localeAtom, initialLocale());
export const resetCatalogState = (registry: AtomRegistry.AtomRegistry) => registry.set(catalogAtom, structuredClone(initialCatalogState));
export const resetWorkbenchState = (registry: AtomRegistry.AtomRegistry) => registry.set(workbenchAtom, structuredClone(initialWorkbenchState));
export const resetTwinPageState = (registry: AtomRegistry.AtomRegistry) => registry.set(twinPageAtom, structuredClone(initialTwinPageState));
export const resetTwinUiState = (registry: AtomRegistry.AtomRegistry) => registry.set(twinUiAtom, createTwinUiState('engineer'));
export const resetTwinDemoState = (registry: AtomRegistry.AtomRegistry) => registry.set(twinDemoAtom, createDemoState(42));
