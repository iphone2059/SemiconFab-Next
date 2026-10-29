import { create, type StoreApi, type UseBoundStore } from 'zustand';

/**
 * Small Zustand store helper for the client-UI state that used to live in Redux
 * Toolkit slices. Reducers are plain pure functions `(state, ...args) => state`
 * (no Immer, no Redux store, no action dispatch and no react-redux dependency),
 * and every reducer's argument list is inferred into a typed action creator, so
 * components call store methods with full type inference and no assertions.
 */

/** One reducer: current state plus typed arguments to the next state. */
export type SliceReducer<S extends object> = (state: S, ...args: never[]) => S;
export type SliceReducerMap<S extends object> = Record<string, SliceReducer<S>>;

/** Drop the leading state argument from a reducer signature to get its action parameters. */
type ActionArgs<P extends readonly unknown[]> = P extends readonly [unknown, ...infer Rest] ? Rest : never;

/** Action creators derived from a reducer map: reducer arguments become action parameters. */
export type SliceActions<M> = {
  [K in keyof M]: M[K] extends (...args: infer P) => object ? (...args: ActionArgs<P>) => void : never;
};

/** Runtime form of a reducer: the helper itself only ever forwards opaque arguments. */
type RuntimeReducer<S extends object> = (state: S, ...args: unknown[]) => S;

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

export interface SliceStore<S extends object, M extends SliceReducerMap<S>> {
  readonly useStore: UseBoundStore<StoreApi<S>>;
  readonly actions: SliceActions<M>;
  readonly reset: () => void;
}

export function createSliceStore<S extends object, M extends SliceReducerMap<S>>(
  initial: S,
  reducers: M,
): SliceStore<S, M> {
  const useStore = create<S>(() => clone(initial));
  const actions: Record<string, (...args: unknown[]) => void> = {};
  for (const [name, reducer] of Object.entries(reducers)) {
    // Reducers are stored behind the `never[]` rest contract; the typed
    // `SliceActions<M>` surface narrows each action back to its own arguments.
    const run = reducer as RuntimeReducer<S>;
    actions[name] = (...args: unknown[]) => {
      useStore.setState(run(useStore.getState(), ...args));
    };
  }
  const reset = () => useStore.setState(clone(initial), true);
  return { useStore, actions: actions as unknown as SliceActions<M>, reset };
}
