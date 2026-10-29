import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { createDemoState, demoReducer, type DemoState } from '@/domain/simulation-twin-equipment';
import { YIELD_SCENARIOS } from '@/domain/fab-yield';
import type { FabToolState } from '@/domain/fab-layout';

const baseline = YIELD_SCENARIOS[0];
// initDigitalTwinEngine initializes once; selecting a Scenario is a later event.
export const initialTwinDemoState: DemoState = createDemoState(42);

export const twinDemoAtom = Atom.make<DemoState>(initialTwinDemoState).pipe(Atom.keepAlive);

const reduce = (registry: AtomRegistry.AtomRegistry, event: Parameters<typeof demoReducer>[1]): void => {
  registry.update(twinDemoAtom, (state) => demoReducer(state, event));
};

export const twinDemoActions = {
  tick: (registry: AtomRegistry.AtomRegistry) => reduce(registry, { type: 'tick' }),
  playingSet: (registry: AtomRegistry.AtomRegistry, playing: boolean) => reduce(registry, { type: 'play', playing }),
  manualStateSet: (registry: AtomRegistry.AtomRegistry, payload: { index: number; state: FabToolState }) => reduce(registry, { type: 'manual', ...payload }),
  manualKeySet: (registry: AtomRegistry.AtomRegistry, payload: { key: string; state: FabToolState }) => reduce(registry, { type: 'manual-key', ...payload }),
  scenarioApplied: (registry: AtomRegistry.AtomRegistry, scenario: typeof baseline) => reduce(registry, { type: 'scenario', scenario }),
};
