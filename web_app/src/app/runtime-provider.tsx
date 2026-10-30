import { createContext, useContext, type ReactNode } from 'react';
import { useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import type { CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import type { FabIdentity } from '@/domain/fab-identity';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';

interface RuntimeContextValue {
  readonly registry: FabRuntimeRegistry;
  /** Bumped when the bootstrap finishes assembling runtimes. */
  readonly version: number;
}

const FabRuntimeContext = createContext<RuntimeContextValue | null>(null);

/** Stable value for "no runtime / no tracked command": never a second state source. */
const EMPTY_PROJECTION_ATOM = Atom.make<CommandWorkflowProjection | undefined>(undefined);

export function RuntimeProvider({ registry, version = 0, children }: { registry: FabRuntimeRegistry; version?: number; children: ReactNode }) {
  const value = (({ registry, version }));
  return <FabRuntimeContext.Provider value={value}>{children}</FabRuntimeContext.Provider>;
}

export function useFabRuntimeRegistry(): FabRuntimeRegistry | null {
  return useContext(FabRuntimeContext)?.registry ?? null;
}

/** Runtime assembly generation; mutable registry contents must be re-read when it changes. */
export function useFabRuntimeVersion(): number {
  return useContext(FabRuntimeContext)?.version ?? 0;
}

/**
 * Read-only command workflow projection (ADR-007 §6, INV-11).
 *
 * The FAB is addressed by its complete composite identity (siteId + fabId): the
 * registry is keyed with fabIdentityKey(), so the same commandId in two sites can
 * never share a runtime or an Atom (R5.4-03 T08).
 *
 * There is exactly one data source: the Atom owned by the FabRuntime's bounded
 * CommandProjectionStore and written only by the runtime. There is no useState
 * fallback, no runtime.subscribe broadcast and no second cache: a replaced
 * runtime yields a different Atom identity, so a stale projection can never leak
 * into the replacement generation.
 */
export function useCommandProjection(identity: FabIdentity, commandId: string): CommandWorkflowProjection | undefined {
  // Validated compiler limitation (CORE-011 family): with Oxc React Compiler
  // 'infer' mode, a custom hook whose only reactive input is an external Atom
  // subscription can be memoized by its call arguments; the read-only projection
  // would then never update. The hook has no optimization value, so it explicitly
  // opts out instead of depending on compiler caching for correctness (spec §4).
  'use no memo';
  const registry = useFabRuntimeRegistry();
  const runtime = registry?.get(identity);
  // Atom identity is stable in the runtime's bounded store, so no memoization is
  // needed (and the hook must not depend on compiler caching for correctness).
  const atom = runtime ? runtime.projectionAtom(commandId) : EMPTY_PROJECTION_ATOM;
  return useAtomValue(atom);
}
