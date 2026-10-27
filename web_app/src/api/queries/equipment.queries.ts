import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { EquipmentStatusSnapshot } from '../../equipment-status';
import { acceptEquipmentStatusSnapshot } from './equipment-status-bridge';
import { fetchJson } from './http';
import { queryKeys } from './queryKeys';

const equipmentStatusSchema = z.object({
  siteId: z.string().min(1),
  fabId: z.string().min(1),
  generatedAt: z.string().min(1),
  sequence: z.number().optional(),
  // A03: zod strips unknown keys, so the additive server generation must be part
  // of the schema or REST frames would silently lose the ordering epoch.
  epoch: z.number().optional(),
  tools: z.array(z.object({ state: z.string().min(1) })).min(1),
});

/**
 * FAB-scoped polling fallback. REST frames go through the same per-scope ordered
 * acceptance gate as SSE and only reach this cache entry when the gate accepts
 * them; a late REST response therefore cannot regress a newer SSE snapshot.
 * The backend serves one independent 121-tool feed and sequence per FAB.
 */
export const equipmentStatusQueryOptions = (siteId: string, fabId: string) =>
  queryOptions({
    queryKey: queryKeys.equipment.status(siteId, fabId),
    queryFn: async ({ client, signal }) => {
      const payload = await fetchJson(
        `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status`,
        { signal },
      );
      const snapshot = equipmentStatusSchema.parse(payload) as EquipmentStatusSnapshot;
      const scope = { siteId, fabId };
      // One acceptance boundary shared with SSE: the bridge performs the ordered
      // check and is the only place that writes the FAB-scoped cache entry.
      const accepted = acceptEquipmentStatusSnapshot(client, scope, snapshot);
      if (accepted) return accepted;
      // A delayed poll must not replace an already accepted (newer) snapshot.
      const cached = client.getQueryData<EquipmentStatusSnapshot>(
        queryKeys.equipment.status(siteId, fabId),
      );
      if (cached) return cached;
      throw new Error(
        '设备状态快照未通过顺序校验 / equipment-status snapshot rejected by the ordered acceptance gate',
      );
    },
    staleTime: 0,
    retry: 0,
  });

/** The Query key that the SSE bridge writes into; exported to avoid ad-hoc keys. */
export const equipmentStatusQueryKey = (siteId: string, fabId: string) => queryKeys.equipment.status(siteId, fabId);
