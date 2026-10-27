import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CommandWorkflowProjection } from '../../application/contracts/CommandWorkflow';
import type { FabRuntimeRegistry } from '../../runtime/FabRuntimeRegistry';

const FabRuntimeContext = createContext<FabRuntimeRegistry | null>(null);

/**
 * Exposes the assembled FAB runtime registry to the React tree. RuntimeBootstrap
 * mounts this in the product; tests may render components without it (hooks
 * return null/undefined).
 */
export function RuntimeProvider({ registry, children }: { registry: FabRuntimeRegistry; children: ReactNode }) {
  return <FabRuntimeContext.Provider value={registry}>{children}</FabRuntimeContext.Provider>;
}

export function useFabRuntimeRegistry(): FabRuntimeRegistry | null {
  return useContext(FabRuntimeContext);
}

/**
 * Read-only workflow projection for one command. It subscribes to runtime
 * notifications and never exposes actor/send APIs to the page.
 */
export function useCommandProjection(fabId: string, commandId: string): CommandWorkflowProjection | undefined {
  const registry = useFabRuntimeRegistry();
  const [projection, setProjection] = useState<CommandWorkflowProjection | undefined>(undefined);

  useEffect(() => {
    const runtime = registry?.get(fabId);
    if (!runtime) {
      setProjection(undefined);
      return;
    }
    const update = () => { setProjection(runtime.getProjection(commandId)); };
    update();
    return runtime.subscribe(update);
  }, [registry, fabId, commandId]);

  return projection;
}
