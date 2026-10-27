import { createContext, useContext, type ReactNode } from 'react';
import type { FabRuntimeRegistry } from '../../runtime/FabRuntimeRegistry';

const FabRuntimeContext = createContext<FabRuntimeRegistry | null>(null);

/**
 * Exposes the assembled FAB runtime registry to the React tree. M4 ships the
 * provider seam only: there is no real WebSocket source yet, so the application
 * does not mount it in AppProviders until the backend command stream exists
 * (M5 wiring).
 */
export function RuntimeProvider({ registry, children }: { registry: FabRuntimeRegistry; children: ReactNode }) {
  return <FabRuntimeContext.Provider value={registry}>{children}</FabRuntimeContext.Provider>;
}

export function useFabRuntimeRegistry(): FabRuntimeRegistry | null {
  return useContext(FabRuntimeContext);
}
