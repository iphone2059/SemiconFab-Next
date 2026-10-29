import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';

export interface WorkbenchFormState {
  lotCount: string;
  processTimeUs: string;
  durationUs: string;
  warmupUs: string;
  masterSeed: string;
}
/**
 * Workbench client UI state only: active site/run selection, the form draft and
 * the current submit error. Server snapshots stay in TanStack Query and the
 * submission lifecycle (idempotency key, in-flight command) stays in
 * controllers/use-run-submission.ts, so the store never mirrors either.
 */
export interface WorkbenchState {
  siteId: string;
  fabIndex: number;
  runId: string;
  form: WorkbenchFormState;
  submitError: string;
}

export const initialWorkbenchState: WorkbenchState = {
  siteId: '',
  fabIndex: 0,
  runId: '',
  form: { lotCount: '24', processTimeUs: '1000000', durationUs: '60000000', warmupUs: '0', masterSeed: '42' },
  submitError: '',
};

const reducers = {
  siteIdSet: (state: WorkbenchState, siteId: string) => state.siteId === siteId
    ? state
    : { ...state, siteId, fabIndex: 0, runId: '', submitError: '' },
  fabIndexSet: (state: WorkbenchState, fabIndex: number) => state.fabIndex === fabIndex ? state : { ...state, fabIndex },
  runsReceived: (state: WorkbenchState, payload: { siteId: string; runIds: string[] }) => state.siteId === payload.siteId && !state.runId
    ? { ...state, runId: payload.runIds[0] ?? '' }
    : state,
  runIdSet: (state: WorkbenchState, runId: string) => ({ ...state, runId, submitError: '' }),
  formFieldSet: (state: WorkbenchState, payload: { field: keyof WorkbenchFormState; value: string }) => ({
    ...state,
    form: { ...state.form, [payload.field]: payload.value },
  }),
  submitErrorSet: (state: WorkbenchState, submitError: string) => ({ ...state, submitError }),
  formReset: (state: WorkbenchState) => ({ ...state, form: initialWorkbenchState.form, submitError: '' }),
};

export const workbenchAtom = Atom.make<WorkbenchState>(initialWorkbenchState).pipe(Atom.keepAlive);

export const workbenchActions = {
  siteIdSet: (registry: AtomRegistry.AtomRegistry, siteId: string): void => {
    registry.update(workbenchAtom, state => reducers.siteIdSet(state, siteId));
  },
  fabIndexSet: (registry: AtomRegistry.AtomRegistry, fabIndex: number): void => {
    registry.update(workbenchAtom, state => reducers.fabIndexSet(state, fabIndex));
  },
  runsReceived: (registry: AtomRegistry.AtomRegistry, payload: { siteId: string; runIds: string[] }): void => {
    registry.update(workbenchAtom, state => reducers.runsReceived(state, payload));
  },
  runIdSet: (registry: AtomRegistry.AtomRegistry, runId: string): void => {
    registry.update(workbenchAtom, state => reducers.runIdSet(state, runId));
  },
  formFieldSet: (registry: AtomRegistry.AtomRegistry, payload: { field: keyof WorkbenchFormState; value: string }): void => {
    registry.update(workbenchAtom, state => reducers.formFieldSet(state, payload));
  },
  submitErrorSet: (registry: AtomRegistry.AtomRegistry, submitError: string): void => {
    registry.update(workbenchAtom, state => reducers.submitErrorSet(state, submitError));
  },
  formReset: (registry: AtomRegistry.AtomRegistry): void => {
    registry.update(workbenchAtom, state => reducers.formReset(state));
  },
};
