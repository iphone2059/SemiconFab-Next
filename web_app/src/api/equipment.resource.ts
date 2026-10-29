import { queryOptions } from '@tanstack/react-query';
import { Effect, Schema } from 'effect';
import { nonEmptyString, nonNegativeInteger } from '@/api/primitives.schema';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { acceptEquipmentStatusSnapshot } from '@/api/equipment-status-bridge';
import { httpTransport, decodeApiResponse } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

const equipmentStatusSchema = Schema.Struct({
  siteId: nonEmptyString,
  fabId: nonEmptyString,
  generatedAt: nonEmptyString,
  sequence: nonNegativeInteger,
  epoch: nonNegativeInteger,
  tools: Schema.Array(Schema.Struct({ state: nonEmptyString })).pipe(Schema.mutable).check(Schema.isMinLength(1)),
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
      const snapshot: EquipmentStatusSnapshot = await Effect.runPromise(fetchEquipmentStatus(siteId, fabId), { signal });
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

export const fetchEquipmentStatus = (siteId: string, fabId: string) => httpTransport.fetchJson(
  `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status`,
).pipe(Effect.flatMap(decodeApiResponse(equipmentStatusSchema, 'invalid equipment-status response')));
