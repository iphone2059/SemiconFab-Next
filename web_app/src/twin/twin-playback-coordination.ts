import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { stopTwinResearchRuntime } from '@/twin/twin-research-runtime';
import { stopTwinTourRuntime } from '@/twin/twin-tour-runtime';
import { stopTwinWaferRuntime } from '@/twin/twin-wafer-runtime';
export type TwinForegroundOwner = 'tour' | 'wafer' | 'research' | null;
export function stopOtherTwinPlaybacks(registry: AtomRegistry.AtomRegistry, owner: TwinForegroundOwner): void {
  if (owner !== 'tour') stopTwinTourRuntime(registry);
  if (owner !== 'wafer') stopTwinWaferRuntime(registry);
  if (owner !== 'research') stopTwinResearchRuntime(registry);
}
