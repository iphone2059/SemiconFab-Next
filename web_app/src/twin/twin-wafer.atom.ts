import type { WaferProduct } from '@/domain/wafer-route';
import type { WaferHud } from '@/domain/wafer-timeline';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * Wafer-follow playback projection.
 *
 * Owner: use-wafer-playback's controller. The timeline pushes a frame at ~20 Hz
 * while the wafer moves; keeping this projection out of the page UI atom means
 * frame cadence never notifies sidebar/dialog/selection subscribers. Closing the
 * session is the explicit closeWaferSession(registry) use case.
 */
export type WaferUiState = {
  product: WaferProduct;
  index: number;
  follow: boolean;
  hud?: WaferHud;
  completed: boolean;
};

export const initialWaferUiState: WaferUiState = { product: 'A', index: 0, follow: true, completed: false };

const wafer = (state: WaferUiState, patch: Partial<WaferUiState>): WaferUiState => ({ ...state, ...patch });

const reducers = {
  waferFrameReceived: (state: WaferUiState, frame: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }) => wafer(state, frame),
  /** Closing a wafer session drops the projected frame; playback ownership stays in twin-ui.atom.ts. */
  waferFrameCleared: (state: WaferUiState) => wafer(state, { hud: undefined, completed: false }),
  waferFollowSet: (state: WaferUiState, follow: boolean) => wafer(state, { follow }),
};

export const twinWaferAtom = Atom.make<WaferUiState>(initialWaferUiState).pipe(Atom.keepAlive);

export const twinWaferActions = {
  waferFrameReceived: (registry: AtomRegistry.AtomRegistry, frame: { product: WaferProduct; index: number; hud: WaferHud; completed: boolean }): void => {
    registry.update(twinWaferAtom, state => reducers.waferFrameReceived(state, frame));
  },
  waferFrameCleared: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(twinWaferAtom, state => reducers.waferFrameCleared(state));
  },
  waferFollowSet: (registry: AtomRegistry.AtomRegistry, follow: boolean): void => {
    registry.update(twinWaferAtom, state => reducers.waferFollowSet(state, follow));
  },
};
