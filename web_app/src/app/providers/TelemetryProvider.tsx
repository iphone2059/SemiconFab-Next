import { createContext, useContext, useMemo, type ReactNode } from 'react';
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
 * The telemetry runtime for one FAB. The Worker/TypedArray path is read inside
 * the renderer frame loop; this hook only resolves the runtime handle and never
 * feeds high-frequency data through React (ARCH-11).
 */
export function useFabTelemetry(fabId: string | undefined): TelemetryRuntime | undefined {
  const registry = useContext(TelemetryContext)?.registry;
  return fabId ? registry?.get(fabId) : undefined;
}
