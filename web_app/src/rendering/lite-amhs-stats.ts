/** Cadence at which the AMHS UI consumer coalesces stats. */
export const AMHS_STATS_INTERVAL_MS = 100;

/**
 * Creates a frame-time gate that accepts at most one AMHS stats sample per interval.
 * The first finite timestamp is accepted. Non-finite timestamps are rejected without
 * moving the last accepted time, so a broken clock cannot consume or delay the interval.
 */
export function createAmhsStatsGate(intervalMs: number = AMHS_STATS_INTERVAL_MS): (nowMs: number) => boolean {
  let lastAccepted = Number.NEGATIVE_INFINITY;
  return (nowMs: number): boolean => {
    if (!Number.isFinite(nowMs)) return false;
    if (nowMs - lastAccepted < intervalMs) return false;
    lastAccepted = nowMs;
    return true;
  };
}
