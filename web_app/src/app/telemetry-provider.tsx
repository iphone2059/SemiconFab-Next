import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { FabIdentity } from '@/domain/fab-identity';
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
 * Returns the telemetry runtime for a complete FAB identity and starts it only
 * while a consumer is mounted. Idle FABs therefore do not hold SSE/Worker
 * connections, and two sites that share a fabId never share a runtime.
 *
 * Acquisition is reference counted per composite identity: concurrent consumers
 * of the same (siteId, fabId) share one runtime and only the last unmount stops
 * it; the release closure is bound to the exact runtime instance, so a registry
 * replacement (sites reload) can never be stopped by a stale cleanup.
 *
 * The hook keys its external-store subscription and its acquire effect on the
 * siteId/fabId primitives (not on the caller's identity object identity): a
 * caller that recreates the identity object every render does not re-subscribe or
 * re-acquire.
 */
export function useFabTelemetry(identity: FabIdentity | undefined): TelemetryRuntime | undefined {
  const registry = useContext(TelemetryContext)?.registry;
  const siteId = identity?.siteId;
  const fabId = identity?.fabId;
  const hasIdentity = siteId !== undefined && fabId !== undefined;
  const subscribe = useCallback(
    (listener: () => void) => registry?.subscribe(listener) ?? (() => {}),
    [registry],
  );
  const getSnapshot = useCallback(
    () => (hasIdentity ? registry?.get({ siteId, fabId }) : undefined),
    [registry, hasIdentity, siteId, fabId],
  );
  const runtime = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  useEffect(() => {
    if (!registry || !hasIdentity) return;
    return registry.acquire({ siteId, fabId });
  }, [registry, hasIdentity, siteId, fabId, runtime]);

  return runtime;
}
