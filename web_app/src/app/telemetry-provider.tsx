import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { FabTelemetryRegistry } from '@/realtime/telemetry-registry';
import type { TelemetryRuntime } from '@/realtime/telemetry-runtime';

interface TelemetryContextValue {
  readonly registry: FabTelemetryRegistry;
  readonly version: number;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ registry, version = 0, children }: { registry: FabTelemetryRegistry; version?: number; children: ReactNode }) {
  const value = (({ registry, version }));
  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

/**
 * Returns the telemetry runtime for a FAB and starts it only while a consumer
 * is mounted. Idle FABs therefore do not hold SSE/Worker connections.
 *
 * Acquisition is reference counted by the registry: concurrent consumers of
 * the same FAB share one runtime and only the last unmount stops it. The
 * runtime identity is part of the effect dependency list so a registry
 * replacement (sites reload) acquires the new generation.
 */
export function useFabTelemetry(fabId: string | undefined): TelemetryRuntime | undefined {
  const registry = useContext(TelemetryContext)?.registry;
  const subscribe = (listener: () => void) => registry?.subscribe(listener) ?? (() => {});
  const getSnapshot = () => fabId ? registry?.get(fabId) : undefined;
  const runtime = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  useEffect(() => {
    if (!registry || !fabId) return;
    return registry.acquire(fabId);
  }, [registry, fabId, runtime]);

  return runtime;
}
