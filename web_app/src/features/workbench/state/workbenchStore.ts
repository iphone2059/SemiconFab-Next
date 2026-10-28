import { createSliceStore } from '../../../state/createSliceStore';

export interface WorkbenchFormState {
  lotCount: string;
  processTimeUs: string;
  durationUs: string;
  warmupUs: string;
  masterSeed: string;
}
export interface WorkbenchState {
  siteId: string;
  runId: string;
  form: WorkbenchFormState;
  submitError: string;
  pendingSubmission?: { json: string; key: string };
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
    : { ...state, siteId, runId: '', submitError: '', pendingSubmission: undefined },
  runsReceived: (state, payload: { siteId: string; runIds: string[] }) => state.siteId === payload.siteId && !state.runId
    ? { ...state, runId: payload.runIds[0] ?? '' }
    : state,
  runIdSet: (state, runId: string) => ({ ...state, runId, submitError: '' }),
  submissionPrepared: (state, pendingSubmission: { json: string; key: string }) => state.pendingSubmission?.json === pendingSubmission.json
    ? state
    : { ...state, pendingSubmission },
  submissionCompleted: (state, payload: { siteId: string; key: string; runId: string }) => state.siteId !== payload.siteId || state.pendingSubmission?.key !== payload.key
    ? state
    : { ...state, runId: payload.runId, pendingSubmission: undefined, submitError: '' },
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
