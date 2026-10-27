import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CommandWorkflowProjection } from '../../application/contracts/CommandWorkflow';
import type { FabRuntimeRegistry } from '../../runtime/FabRuntimeRegistry';

interface RuntimeContextValue {
  readonly registry: FabRuntimeRegistry;
  /** Bumped when the bootstrap finishes assembling runtimes. */
  readonly version: number;
}

const FabRuntimeContext = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({ registry, version = 0, children }: { registry: FabRuntimeRegistry; version?: number; children: ReactNode }) {
  const value = useMemo(() => ({ registry, version }), [registry, version]);
  return <FabRuntimeContext.Provider value={value}>{children}</FabRuntimeContext.Provider>;
}

export function useFabRuntimeRegistry(): FabRuntimeRegistry | null {
  return useContext(FabRuntimeContext)?.registry ?? null;
}

/**
 * Read-only workflow projection for one command. It subscribes to runtime
 * notifications and never exposes actor/send APIs to the page.
 */
export function useCommandProjection(fabId: string, commandId: string): CommandWorkflowProjection | undefined {
  const registry = useFabRuntimeRegistry();
  // Derive the current runtime per render. The Provider version bump after a
  // RuntimeBootstrap rebuild re-renders consumers, so the effect re-subscribes
  // to the replacement runtime instead of keeping the disposed one.
  const runtime = registry?.get(fabId);
  const [projection, setProjection] = useState<CommandWorkflowProjection | undefined>(undefined);

  useEffect(() => {
    if (!runtime) {
      setProjection(undefined);
      return;
    }
    const update = () => { setProjection(runtime.getProjection(commandId)); };
    update();
    return runtime.subscribe(update);
  }, [runtime, commandId]);

  return projection;
}
