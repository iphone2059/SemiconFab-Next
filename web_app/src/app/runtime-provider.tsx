import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';

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
 * Value equality for the read-only projection. FabRuntime.subscribe is a
 * per-FAB broadcast and getProjection() builds a fresh object per call, so
 * without this check every command result would setState every ProjectionRow
 * (B05). Field-by-field equality is sufficient: the projection is exactly
 * state/revision/outcome and carries no nested data.
 */
function sameProjection(left: CommandWorkflowProjection | undefined, right: CommandWorkflowProjection | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.state === right.state && left.revision === right.revision && left.outcome === right.outcome;
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
  // Compare-and-commit through a ref so a value-equal broadcast schedules no
  // React update at all (a functional setState with the previous value may still
  // render once before bailing out). The ref mirrors the committed state.
  const committed = useRef<CommandWorkflowProjection | undefined>(undefined);

  useEffect(() => {
    if (!runtime) {
      committed.current = undefined;
      setProjection(undefined);
      return;
    }
    const update = () => {
      const next = runtime.getProjection(commandId);
      if (sameProjection(committed.current, next)) return;
      committed.current = next;
      setProjection(next);
    };
    update();
    return runtime.subscribe(update);
  }, [runtime, commandId]);

  return projection;
}
