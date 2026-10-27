import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { FabTelemetryRegistry } from '../../realtime/telemetry/FabTelemetryRegistry';
import type { TelemetryRuntime } from '../../realtime/telemetry/TelemetryRuntime';

interface TelemetryContextValue {
  readonly registry: FabTelemetryRegistry;
  readonly version: number;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ registry, version = 0, children }: { registry: FabTelemetryRegistry; version?: number; children: ReactNode }) {
  const value = useMemo(() => ({ registry, version }), [registry, version]);
  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

/**
 * Returns the telemetry runtime for a FAB and starts it only while a consumer
 * is mounted. Idle FABs therefore do not hold SSE/Worker connections.
 */
export function useFabTelemetry(fabId: string | undefined): TelemetryRuntime | undefined {
  const registry = useContext(TelemetryContext)?.registry;
  const runtime = fabId ? registry?.get(fabId) : undefined;

  useEffect(() => {
    if (!runtime) return;
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);

  return runtime;
}
