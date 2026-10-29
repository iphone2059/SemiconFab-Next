import type { FabToolState } from '@/domain/fab-layout';

export type ToolStateMerger = (
  base: readonly FabToolState[],
  live: readonly FabToolState[] | undefined,
) => readonly FabToolState[];

/**
 * Reference-cached merge for the scene frame loop. The base Zustand snapshot and
 * the telemetry Worker snapshot both keep their array identity until their data
 * actually changes, so identical references let a frame reuse the previous merge
 * instead of copying the 121-entry tool-state array.
 */
export function createToolStateMerger(): ToolStateMerger {
  let lastBase: readonly FabToolState[] | undefined;
  let lastLive: readonly FabToolState[] | undefined;
  let lastResult: readonly FabToolState[] | undefined;

  return (base, live) => {
    if (lastResult !== undefined && base === lastBase && live === lastLive) return lastResult;
    if (live === undefined) {
      lastBase = base;
      lastLive = live;
      lastResult = base;
      return base;
    }
    const merged = base.slice();
    const length = Math.min(live.length, merged.length);
    for (let index = 0; index < length; index += 1) merged[index] = live[index];
    lastBase = base;
    lastLive = live;
    lastResult = merged;
    return merged;
  };
}
