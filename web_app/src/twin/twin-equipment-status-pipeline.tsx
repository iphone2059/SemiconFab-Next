import { RegistryContext } from '@effect/atom-react';
import { useContext, useRef } from 'react';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { watchEquipmentStatus } from '@/realtime/equipment-status.transport';
import type { EquipmentStatusSnapshot, EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import { FAB_LAYOUT, type FabToolState } from '@/domain/fab-layout';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
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
 * A01/A02: isolated subscriber for the FAB-scoped equipment status.
 *
 * The ResourceManager-owned Atom is the single accepted-snapshot owner (ADR-006
 * §2.5). REST (manager poll) and SSE both commit through
 * `resources.publish(handle, snapshot, 'push')`: the definition's accept hook reads
 * the current (epoch, sequence) from the same Atom in the same synchronous commit
 * step and returns Publish | Ignore. Ignore never replaces the accepted payload;
 * a current read may still complete waiting or clear an error for a validated
 * unchanged response. These control updates keep the payload reference stable.
 *
 * Scope handover is atomic: pending frames from the previous FAB are cancelled in
 * a layout effect, the old EventSource generation is aborted, and every FAB-scoped
 * store projection is cleared before the browser can paint.
 */
export function EquipmentStatusPipeline({ siteId, fabId }: EquipmentStatusPipelineProps) {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const scope = useMemo<EquipmentStatusScope>(() => ({ siteId, fabId }), [siteId, fabId]);
  const definition = useMemo(() => equipmentStatusDefinition(siteId, fabId), [siteId, fabId]);
  const handle = useMemo(() => appRuntime.resources.handle(definition), [appRuntime, definition]);
  /** Snapshot high-water at provider/scope activation; older cached values stay in the Atom
   * (resource retention) but must not repopulate the freshly cleared UI projection. */
  const activationBaseline = useRef<{ epoch: number; sequence: number } | undefined>(undefined);
  /** Scope generation token: a callback from a previous activation may never reach the page. */
  const generation = useRef(0);
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
    generation.current += 1;
    const cached = appRuntime.resources.value(handle);
    // A provider/runtime replacement is a new UI lifetime: keep the Atom's high-water
    // but do not replay the pre-replacement snapshot into the freshly cleared page.
    // An ordinary unmount/remount of the same runtime may resume from the accepted
    // Atom value (same as the previous cache behavior).
    const previousRuntime = runtimeByRegistry.get(registry);
    const replaced = previousRuntime !== undefined && previousRuntime !== appRuntime;
    runtimeByRegistry.set(registry, appRuntime);
    activationBaseline.current = replaced && cached ? { epoch: cached.epoch, sequence: cached.sequence } : undefined;
    twinPageActions.liveScopeActivated(registry, scope);
  }, [appRuntime, batcher, fabId, handle, registry, scope, siteId]);
  useLayoutEffect(() => () => batcher.cancel(), [batcher]);

  // The page's only REST poll subscription; the resource policy keeps it at 4s and
  // only while this component is mounted (the ResourceManager owns the single timer).
  const statusView = useResource(appRuntime, definition);

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
    const connectionGeneration = generation.current;
    watchEquipmentStatus(source, scope, (snapshot) => {
      if (controller.signal.aborted || generation.current !== connectionGeneration) return;
      // One acceptance boundary: a frame rejected by the ordered accept hook is
      // never written to the FAB-scoped Atom (and therefore never reaches the page).
      appRuntime.resources.publish(handle, snapshot, 'push');
    }, () => {
      if (!controller.signal.aborted) twinPageActions.statusFeedStale(registry, { scope });
    }, controller.signal);
    return () => {
      controller.abort();
      batcher.cancel();
    };
  }, [appRuntime, batcher, fabId, handle, registry, scope, siteId]);

  return null;
}
