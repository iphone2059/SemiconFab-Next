import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { produce } from 'immer';
import type { Draft } from 'immer';

/**
 * Small Zustand store helper for the state that used to live in Redux Toolkit
 * slices. Reducer bodies stay mutation-style via Immer, but there is no Redux
 * store, no action dispatch and no react-redux dependency. Actions are bound
 * store methods so components can call them directly.
 */
export type SliceAction = { readonly type: string; readonly payload?: any };
export type SliceReducer<S> = (state: Draft<S>, action: SliceAction) => void;

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

export interface SliceStore<S extends object> {
  readonly useStore: UseBoundStore<StoreApi<S>>;
  readonly actions: Record<string, (payload?: any) => void>;
  readonly reset: () => void;
}

export function createImmerStore<S extends object>(
  initial: S,
  reducers: Record<string, SliceReducer<S>>,
): SliceStore<S> {
  const useStore = create<S>(() => clone(initial));
  const actions: Record<string, (payload?: any) => void> = {};
  for (const [name, reducer] of Object.entries(reducers)) {
    actions[name] = (payload?: any) => {
      useStore.setState(produce(useStore.getState(), (draft) => {
        reducer(draft, { type: name, payload });
      }));
    };
  }
  const reset = () => useStore.setState(clone(initial), true);
  return { useStore, actions, reset };
}
