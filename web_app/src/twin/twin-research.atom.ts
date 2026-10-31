import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { FabToolState } from '@/domain/fab-layout';
import type { ResearchSnapshot } from '@/domain/simulation-research-replay';
import type { projectReplayStates } from '@/domain/simulation-twin-equipment';
export type TwinResearchSpeed = 1 | 10 | 100 | 500;
export type TwinResearchStatus = 'inactive' | 'loading' | 'paused' | 'playing' | 'completed' | 'failed';
export interface TwinResearchProjection {
  readonly scopeKey: string;
  readonly status: TwinResearchStatus;
  readonly timeSec: number;
  readonly speed: TwinResearchSpeed;
  readonly durationSec: number;
  readonly eventCount: number;
  readonly parseError: string;
  readonly snapshot?: ResearchSnapshot;
  readonly replayProjection?: ReturnType<typeof projectReplayStates>;
}
export const initialTwinResearchProjection: TwinResearchProjection = {
  scopeKey: '',
  status: 'inactive',
  timeSec: 0,
  speed: 100,
  durationSec: 0,
  eventCount: 0,
  parseError: '',
};
export const twinResearchAtom = Atom.make<TwinResearchProjection>(initialTwinResearchProjection).pipe(Atom.keepAlive);
export const twinResearchActions = {
  projectionSet: (registry: AtomRegistry.AtomRegistry, value: TwinResearchProjection): void => {
    registry.set(twinResearchAtom, value);
  },
};
export function readResearchToolStates(registry: AtomRegistry.AtomRegistry, scopeKey: string, baseline: readonly FabToolState[]): readonly FabToolState[] {
  const projection = registry.get(twinResearchAtom);
  return projection.scopeKey === scopeKey && projection.replayProjection !== undefined ? projection.replayProjection.states : baseline;
}