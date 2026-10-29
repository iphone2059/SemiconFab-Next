import type { ResourcePolicy } from '@/api/resource';

export type { ResourcePolicy };

/**
 * Central resource policies. freshnessMs controls revalidation on mount/navigation;
 * idleTtlMs controls manager/Atom retention after the last consumer; pollMs is owned
 * by the ResourceManager and is only active while at least one consumer is retained
 * (never a per-component timer). These values replace the previous Query
 * staleTime/gcTime/refetchInterval combination; they are deliberately not a
 * Query-compatible cache configuration.
 */
export const RESOURCE_POLICIES = {
  sites: { freshnessMs: 30_000, idleTtlMs: 300_000 },
  catalog: { freshnessMs: 60_000, idleTtlMs: 300_000 },
  runs: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 1_500 },
  runDetail: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 1_500 },
  runResults: { freshnessMs: 0, idleTtlMs: 300_000 },
  equipmentStatus: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 4_000 },
  researchEvents: { freshnessMs: Number.POSITIVE_INFINITY, idleTtlMs: 600_000 },
  waferRoutes: { freshnessMs: Number.POSITIVE_INFINITY, idleTtlMs: 600_000 },
} as const satisfies Record<string, ResourcePolicy>;
