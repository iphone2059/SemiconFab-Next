import { createSliceStore } from '@/state/create-slice-store';

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
  runId: string;
  form: WorkbenchFormState;
  submitError: string;
}

export const initialWorkbenchState: WorkbenchState = {
  siteId: '',
  runId: '',
  form: { lotCount: '24', processTimeUs: '1000000', durationUs: '60000000', warmupUs: '0', masterSeed: '42' },
  submitError: '',
};

const workbench = createSliceStore(initialWorkbenchState, {
  siteIdSet: (state, siteId: string) => state.siteId === siteId
    ? state
    : { ...state, siteId, runId: '', submitError: '' },
  runsReceived: (state, payload: { siteId: string; runIds: string[] }) => state.siteId === payload.siteId && !state.runId
    ? { ...state, runId: payload.runIds[0] ?? '' }
    : state,
  runIdSet: (state, runId: string) => ({ ...state, runId, submitError: '' }),
  formFieldSet: (state, payload: { field: keyof WorkbenchFormState; value: string }) => ({
    ...state,
    form: { ...state.form, [payload.field]: payload.value },
  }),
  submitErrorSet: (state, submitError: string) => ({ ...state, submitError }),
  formReset: (state) => ({ ...state, form: initialWorkbenchState.form, submitError: '' }),
});

export const useWorkbenchStore = workbench.useStore;
export const workbenchActions = workbench.actions;
export const resetWorkbenchStore = workbench.reset;
