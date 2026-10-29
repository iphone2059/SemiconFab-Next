/**
 * Central resource policies (Task 5). freshnessMs controls revalidation on
 * mount/navigation; idleTtlMs controls Atom retention after the last consumer;
 * pollMs is only active while a consumer is mounted (no global polling).
 *
 * These values are the documented replacement for the previous Query
 * staleTime/gcTime/refetchInterval combination; they are deliberately not a
 * Query-compatible cache configuration.
 */
export interface ResourcePolicy {
  readonly freshnessMs: number;
  readonly idleTtlMs: number;
  readonly pollMs?: number;
}

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
