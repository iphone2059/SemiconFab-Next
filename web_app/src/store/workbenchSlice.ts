import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

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
const initial: WorkbenchState = {
  siteId: '',
  runId: '',
  form: { lotCount: '24', processTimeUs: '1000000', durationUs: '60000000', warmupUs: '0', masterSeed: '42' },
  submitError: '',
};

export const workbenchSlice = createSlice({
  name: 'workbench',
  initialState: initial,
  reducers: {
    siteIdSet(state, action: PayloadAction<string>) {
      if (state.siteId === action.payload) return;
      state.siteId = action.payload;
      state.runId = '';
      state.submitError = '';
      state.pendingSubmission = undefined;
    },
    runsReceived(state, action: PayloadAction<{ siteId: string; runIds: string[] }>) {
      // Polling initializes an empty selection. A stale list must never replace
      // an explicit selection or the run just returned by createRun.
      if (state.siteId === action.payload.siteId && !state.runId) state.runId = action.payload.runIds[0] ?? '';
    },
    runIdSet(state, action: PayloadAction<string>) { state.runId = action.payload; state.submitError = ''; },
    submissionPrepared(state, action: PayloadAction<{ json: string; key: string }>) {
      if (state.pendingSubmission?.json !== action.payload.json) state.pendingSubmission = action.payload;
    },
    submissionCompleted(state, action: PayloadAction<{ siteId: string; key: string; runId: string }>) {
      if (state.siteId !== action.payload.siteId || state.pendingSubmission?.key !== action.payload.key) return;
      state.runId = action.payload.runId;
      state.pendingSubmission = undefined;
      state.submitError = '';
    },
    formFieldSet(state, action: PayloadAction<{ field: keyof WorkbenchFormState; value: string }>) { state.form[action.payload.field] = action.payload.value; },
    submitErrorSet(state, action: PayloadAction<string>) { state.submitError = action.payload; },
    formReset(state) { state.form = initial.form; state.submitError = ''; },
  },
});
export const workbenchActions = workbenchSlice.actions;
