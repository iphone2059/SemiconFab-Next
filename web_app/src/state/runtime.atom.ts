import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

/**
 * Application-level runtime state, owned by the app shell (error boundary, bootstrap).
 *
 * The former `state/runtime-store.ts` mixed this with the per-viewer GPU lifecycle;
 * that lifecycle now lives in `state/viewer.atom.ts` because its owner is the
 * rendering scope, not the application. This atom only carries cross-page,
 * cross-FAB application data.
 */
export interface RuntimeState {
  fatalError?: string;
}

export const initialRuntimeState: RuntimeState = {};

export const runtimeAtom = Atom.make<RuntimeState>(initialRuntimeState).pipe(Atom.keepAlive);

/** Application-level runtime commands. Viewer lifecycle commands live in viewer.atom.ts. */
export const runtimeActions = {
  fatalErrorSet: (registry: AtomRegistry.AtomRegistry, fatalError: string): void => {
    registry.update(runtimeAtom, state => ({ ...state, fatalError }));
  },
};
