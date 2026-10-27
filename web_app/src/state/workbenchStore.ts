import { createSliceStore } from './createSliceStore';

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
  siteIdSet: (state, action) => state.siteId === action.payload
    ? state
    : { ...state, siteId: action.payload, runId: '', submitError: '', pendingSubmission: undefined },
  runsReceived: (state, action) => state.siteId === action.payload.siteId && !state.runId
    ? { ...state, runId: action.payload.runIds[0] ?? '' }
    : state,
  runIdSet: (state, action) => ({ ...state, runId: action.payload, submitError: '' }),
  submissionPrepared: (state, action) => state.pendingSubmission?.json === action.payload.json
    ? state
    : { ...state, pendingSubmission: action.payload },
  submissionCompleted: (state, action) => state.siteId !== action.payload.siteId || state.pendingSubmission?.key !== action.payload.key
    ? state
    : { ...state, runId: action.payload.runId, pendingSubmission: undefined, submitError: '' },
  formFieldSet: (state, action) => ({
    ...state,
    form: { ...state.form, [action.payload.field as keyof WorkbenchFormState]: action.payload.value },
  }),
  submitErrorSet: (state, action) => ({ ...state, submitError: action.payload }),
  formReset: (state) => ({ ...state, form: initialWorkbenchState.form, submitError: '' }),
});

export const useWorkbenchStore = workbench.useStore;
export const workbenchActions = workbench.actions as {
  siteIdSet: (siteId: string) => void;
  runsReceived: (payload: { siteId: string; runIds: string[] }) => void;
  runIdSet: (runId: string) => void;
  submissionPrepared: (payload: { json: string; key: string }) => void;
  submissionCompleted: (payload: { siteId: string; key: string; runId: string }) => void;
  formFieldSet: (payload: { field: keyof WorkbenchFormState; value: string }) => void;
  submitErrorSet: (error: string) => void;
  formReset: () => void;
};
export const resetWorkbenchStore = workbench.reset;
