import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import type { EquipmentStatusSnapshot } from '../../equipment-status';
import { fetchJson } from './http';
import { queryKeys } from './queryKeys';

const equipmentStatusSchema = z.object({
  siteId: z.string().min(1),
  fabId: z.string().min(1),
  generatedAt: z.string().min(1),
  sequence: z.number().optional(),
  tools: z.array(z.object({ state: z.string().min(1) })).min(1),
});

/**
 * FAB-scoped polling fallback; SSE snapshots overwrite the same cache entry.
 * The backend serves one independent 121-tool feed and sequence per FAB.
 */
export const equipmentStatusQueryOptions = (siteId: string, fabId: string) =>
  queryOptions({
    queryKey: queryKeys.equipment.status(siteId, fabId),
    queryFn: async ({ signal }) => {
      const payload = await fetchJson(
        `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status`,
        { signal },
      );
      return equipmentStatusSchema.parse(payload) as EquipmentStatusSnapshot;
    },
    staleTime: 0,
    retry: 0,
  });

/** The Query key that the SSE bridge writes into; exported to avoid ad-hoc keys. */
export const equipmentStatusQueryKey = (siteId: string, fabId: string) => queryKeys.equipment.status(siteId, fabId);
