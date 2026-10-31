import type { WaferProduct } from '@/domain/wafer-route';
import type { WaferHud } from '@/domain/wafer-timeline';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { TwinWaferSpeed } from '@/twin/twin-wafer.machine';
export interface TwinWaferProjection {
  readonly active: boolean;
  readonly playing: boolean;
  readonly speed: TwinWaferSpeed;
  readonly product: WaferProduct;
  readonly index: number;
  readonly follow: boolean;
  readonly hud?: WaferHud;
  readonly completed: boolean;
}
export interface TwinWaferProcessProjection {
  readonly active: boolean;
  readonly playing: boolean;
  readonly speed: TwinWaferSpeed;
  readonly product: WaferProduct;
  readonly index: number;
  readonly completed: boolean;
}
export const initialTwinWaferProjection: TwinWaferProjection = {
  active: false,
  playing: false,
  speed: 1,
  product: 'A',
  index: 0,
  follow: true,
  completed: false,
};
export const twinWaferAtom = Atom.make<TwinWaferProjection>(initialTwinWaferProjection).pipe(Atom.keepAlive);
export const twinWaferActions = {
  projectionSet: (registry: AtomRegistry.AtomRegistry, projection: TwinWaferProcessProjection): void => {
    registry.update(twinWaferAtom, current =>
      current.active === projection.active
      && current.playing === projection.playing
      && current.speed === projection.speed
      && current.product === projection.product
      && current.index === projection.index
      && current.completed === projection.completed
        ? current
        : { ...current, ...projection });
  },
  hudSet: (registry: AtomRegistry.AtomRegistry, hud: WaferHud): void => {
    registry.update(twinWaferAtom, current => current.hud === hud ? current : { ...current, hud });
  },
  hudClear: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(twinWaferAtom, current =>
      current.hud === undefined && !current.completed
        ? current
        : { ...current, hud: undefined, completed: false });
  },
  followSet: (registry: AtomRegistry.AtomRegistry, follow: boolean): void => {
    registry.update(twinWaferAtom, current =>
      current.follow === follow ? current : { ...current, follow });
  },
};
