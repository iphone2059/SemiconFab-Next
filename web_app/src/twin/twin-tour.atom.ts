import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
export interface TwinTourProjection {
  readonly active: boolean;
  readonly waypoint: number;
}
export const initialTwinTourProjection: TwinTourProjection = { active: false, waypoint: 0 };
export const twinTourAtom = Atom.make<TwinTourProjection>(initialTwinTourProjection).pipe(Atom.keepAlive);
export const twinTourActions = {
  projectionSet(registry: AtomRegistry.AtomRegistry, projection: TwinTourProjection): void {
    registry.update(twinTourAtom, current =>
      current.active === projection.active && current.waypoint === projection.waypoint
        ? current
        : projection);
  },
};
