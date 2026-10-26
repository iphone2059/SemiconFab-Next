import { createImmerStore } from './createImmerStore';

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

const workbench = createImmerStore(initialWorkbenchState, {
  siteIdSet(state, action) {
    if (state.siteId === action.payload) return;
    state.siteId = action.payload;
    state.runId = '';
    state.submitError = '';
    state.pendingSubmission = undefined;
  },
  runsReceived(state, action) {
    if (state.siteId === action.payload.siteId && !state.runId) state.runId = action.payload.runIds[0] ?? '';
  },
  runIdSet(state, action) { state.runId = action.payload; state.submitError = ''; },
  submissionPrepared(state, action) {
    if (state.pendingSubmission?.json !== action.payload.json) state.pendingSubmission = action.payload;
  },
  submissionCompleted(state, action) {
    if (state.siteId !== action.payload.siteId || state.pendingSubmission?.key !== action.payload.key) return;
    state.runId = action.payload.runId;
    state.pendingSubmission = undefined;
    state.submitError = '';
  },
  formFieldSet(state, action) { state.form[action.payload.field as keyof WorkbenchFormState] = action.payload.value; },
  submitErrorSet(state, action) { state.submitError = action.payload; },
  formReset(state) { state.form = initialWorkbenchState.form; state.submitError = ''; },
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
