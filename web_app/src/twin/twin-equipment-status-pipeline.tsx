import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { watchEquipmentStatus } from '@/realtime/equipment-status.transport';
import type { EquipmentStatusSnapshot, EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import { FAB_LAYOUT, type FabToolState } from '@/domain/fab-layout';
import { equipmentStatusQueryOptions } from '@/api/equipment.resource';
import { acceptEquipmentStatusSnapshot, activateEquipmentStatusScope } from '@/api/equipment-status-bridge';
import { createCoalescedDispatcher } from '@/lib/coalesced-dispatcher';
import { twinPageActions } from '@/twin/twin-page.atom';

interface EquipmentStatusPipelineProps {
  siteId: string;
  fabId: string;
}

interface EquipmentStatusProjectionFrame {
  readonly scope: EquipmentStatusScope;
  readonly snapshot: EquipmentStatusSnapshot;
}

/**
 * A01/A02: isolated subscriber for the FAB-scoped equipment status. Keeping the
 * Query subscription and the SSE listener in a child that renders nothing means
 * a raw SSE cache write no longer rerenders TwinContent/FabViewport; accepted
 * frames reach the page at most once per 100 ms through the shared batcher.
 *
 * Scope handover is atomic: pending frames from the previous FAB are cancelled in
 * a layout effect, the new scope starts with a fresh ordering high-water seeded
 * from the accepted cache, and every FAB-scoped store projection is cleared
 * before the browser can paint. Store actions additionally carry the composite
 * scope as a token, so a stale callback can never apply to the new FAB.
 */
export function EquipmentStatusPipeline({ siteId, fabId }: EquipmentStatusPipelineProps) {
  const registry = useContext(RegistryContext);
  const queryClient = useQueryClient();
  const scope = useMemo<EquipmentStatusScope>(() => ({ siteId, fabId }), [siteId, fabId, registry]);
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
    activateEquipmentStatusScope(queryClient, scope, () => twinPageActions.statusFeedStale(registry, { scope }));
    twinPageActions.liveScopeActivated(registry, scope);
  }, [batcher, queryClient, scope, registry]);
  useLayoutEffect(() => () => batcher.cancel(), [batcher, registry]);

  // The page's only subscription for the FAB status entry. The queryFn already
  // gated REST frames; SSE frames go through the same gate in the effect below.
  const statusQuery = useQuery({
    ...equipmentStatusQueryOptions(siteId, fabId),
    refetchInterval: 4000,
  });

  // The accepted Query cache entry is the single snapshot owner; this is the one
  // path that feeds the throttled projection (no per-frame parent render).
  useEffect(() => {
    if (statusQuery.data) batcher.push({ scope, snapshot: statusQuery.data });
  }, [batcher, scope, statusQuery.data, registry]);

  useEffect(() => {
    if (statusQuery.isError) twinPageActions.statusFeedStale(registry, { scope });
  }, [scope, statusQuery.isError, registry]);

  useEffect(() => {
    const controller = new AbortController();
    const source = new EventSource(
      `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status/stream`,
    );
    watchEquipmentStatus(source, scope, (snapshot) => {
      // One acceptance boundary: a frame the ordered consumer rejects is never
      // written to the FAB-scoped cache (and therefore never reaches the page).
      acceptEquipmentStatusSnapshot(queryClient, scope, snapshot);
    }, () => twinPageActions.statusFeedStale(registry, { scope }), controller.signal);
    return () => controller.abort();
  }, [fabId, queryClient, scope, siteId, registry]);

  return null;
}
