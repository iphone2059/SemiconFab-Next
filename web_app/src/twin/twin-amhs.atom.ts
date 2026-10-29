import type { AmhsStats } from '@/contracts/scene.port';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * AMHS simulation statistics pushed from the scene frame loop at ~10 Hz
 * (coalesced to 100 ms by the page). Owner: the GPU scene; only the small AMHS
 * readouts subscribe. Kept out of the page UI atom so the scene cadence cannot
 * notify sidebar/dialog/selection subscribers.
 */
export const twinAmhsAtom = Atom.make<AmhsStats | undefined>(undefined).pipe(Atom.keepAlive);

export const twinAmhsActions = {
  amhsSet: (registry: AtomRegistry.AtomRegistry, amhs?: AmhsStats): void => {
    registry.set(twinAmhsAtom, amhs);
  },
};
