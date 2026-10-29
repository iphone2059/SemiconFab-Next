import { RegistryContext } from '@effect/atom-react';
import { useContext, useRef } from 'react';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { watchEquipmentStatus } from '@/realtime/equipment-status.transport';
import type { EquipmentStatusSnapshot, EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import { FAB_LAYOUT, type FabToolState } from '@/domain/fab-layout';
import { acceptEquipmentStatusSnapshot, activateEquipmentStatusScope, equipmentStatusResource } from '@/api/equipment.resource';
import { resourceValue } from '@/api/resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import type { AppRuntime } from '@/app/app-runtime';
import { createCoalescedDispatcher } from '@/lib/coalesced-dispatcher';
import { twinPageActions } from '@/twin/twin-page.atom';

interface EquipmentStatusPipelineProps {
  siteId: string;
  fabId: string;
}

/** Last AppRuntime observed per registry: distinguishes provider replacement from a page remount. */
const runtimeByRegistry = new WeakMap<object, AppRuntime<never>>();

interface EquipmentStatusProjectionFrame {
  readonly scope: EquipmentStatusScope;
  readonly snapshot: EquipmentStatusSnapshot;
}

/**
 * A01/A02: isolated subscriber for the FAB-scoped equipment status. The resource
 * Atom owns the accepted snapshot; SSE and REST share one ordering gate, and this
 * child only forwards accepted snapshots into the 100 ms page batcher, so a raw
 * frame never rerenders TwinContent/FabViewport.
 *
 * Scope handover is atomic: pending frames from the previous FAB are cancelled in
 * a layout effect, the new scope starts with a fresh ordering high-water seeded
 * from the accepted Atom value, and every FAB-scoped store projection is cleared
 * before the browser can paint.
 */
export function EquipmentStatusPipeline({ siteId, fabId }: EquipmentStatusPipelineProps) {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const scope = useMemo<EquipmentStatusScope>(() => ({ siteId, fabId }), [siteId, fabId]);
  const resource = equipmentStatusResource(siteId, fabId);
  /** Snapshot high-water at provider/scope activation; older cached values stay in the Atom
   * (resource retention) but must not repopulate the freshly cleared UI projection. */
  const activationBaseline = useRef<{ epoch: number; sequence: number } | undefined>(undefined);
  // Owner object: the coalescing timer identity must survive renders.
  const batcher = useMemo(() => createCoalescedDispatcher<EquipmentStatusProjectionFrame>((frame) => {
    const states = FAB_LAYOUT.map((_, index): FabToolState => {
      const value = frame.snapshot.tools[index]?.state;
      return value === 'running' || value === 'idle' || value === 'down' || value === 'maint' ? value : 'idle';
    });
    twinPageActions.liveSnapshotReceived(registry, { scope: frame.scope, states, updatedAt: frame.snapshot.generatedAt });
  }, 100), [registry]);
  useLayoutEffect(() => {
    // Atomic handover: cancel A's pending batch before the new ordering history
    // and projections exist, all before paint.
    batcher.cancel();
    const cached = resourceValue(registry, equipmentStatusResource(siteId, fabId));
    // A provider/runtime replacement is a new UI lifetime: keep the Atom's high-water
    // but do not replay the pre-replacement snapshot into the freshly cleared page.
    // An ordinary unmount/remount of the same runtime may resume from the accepted
    // Atom value (same as the previous cache behavior).
    const previousRuntime = runtimeByRegistry.get(registry);
    const replaced = previousRuntime !== undefined && previousRuntime !== appRuntime;
    runtimeByRegistry.set(registry, appRuntime);
    activationBaseline.current = replaced && cached ? { epoch: cached.epoch, sequence: cached.sequence } : undefined;
    activateEquipmentStatusScope(registry, scope, () => twinPageActions.statusFeedStale(registry, { scope }));
    twinPageActions.liveScopeActivated(registry, scope);
  }, [appRuntime, batcher, fabId, registry, scope, siteId]);
  useLayoutEffect(() => () => batcher.cancel(), [batcher]);

  // The page's only REST poll subscription; the resource policy keeps it at 4s and
  // only while this component is mounted.
  const statusView = useResource(appRuntime, resource);

  // The accepted Atom value is the single snapshot owner; this is the one path
  // that feeds the throttled projection (no per-frame parent render).
  useEffect(() => {
    const snapshot = statusView.data;
    if (!snapshot) return;
    const baseline = activationBaseline.current;
    // Keep the atomic clear from being undone by a cached snapshot from before this
    // provider/scope lifetime; only a strictly newer epoch/sequence repopulates it.
    if (baseline && (snapshot.epoch < baseline.epoch || (snapshot.epoch === baseline.epoch && snapshot.sequence <= baseline.sequence))) return;
    batcher.push({ scope, snapshot });
  }, [batcher, scope, statusView.data]);

  useEffect(() => {
    if (statusView.isError) twinPageActions.statusFeedStale(registry, { scope });
  }, [scope, statusView.isError, registry]);

  useEffect(() => {
    const controller = new AbortController();
    const source = new EventSource(
      `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status/stream`,
    );
    watchEquipmentStatus(source, scope, (snapshot) => {
      // One acceptance boundary: a frame the ordered consumer rejects is never
      // written to the FAB-scoped Atom (and therefore never reaches the page).
      acceptEquipmentStatusSnapshot(appRuntime, scope, snapshot);
    }, () => twinPageActions.statusFeedStale(registry, { scope }), controller.signal);
    return () => controller.abort();
  }, [appRuntime, fabId, registry, scope, siteId]);

  return null;
}
