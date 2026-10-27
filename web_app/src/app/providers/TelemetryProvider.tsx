import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SiteTelemetryRegistry } from '../../realtime/telemetry/SiteTelemetryRegistry';
import type { TelemetryRuntime } from '../../realtime/telemetry/TelemetryRuntime';

interface TelemetryContextValue {
  readonly registry: SiteTelemetryRegistry;
  readonly version: number;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ registry, version = 0, children }: { registry: SiteTelemetryRegistry; version?: number; children: ReactNode }) {
  const value = useMemo(() => ({ registry, version }), [registry, version]);
  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useSiteTelemetry(siteId: string | undefined): TelemetryRuntime | undefined {
  const registry = useContext(TelemetryContext)?.registry;
  return siteId ? registry?.get(siteId) : undefined;
}
