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
    siteIdSet(state, action: PayloadAction<string>) { state.siteId = action.payload; },
    runIdSet(state, action: PayloadAction<string>) { state.runId = action.payload; state.submitError = ''; },
    formFieldSet(state, action: PayloadAction<{ field: keyof WorkbenchFormState; value: string }>) { state.form[action.payload.field] = action.payload.value; },
    submitErrorSet(state, action: PayloadAction<string>) { state.submitError = action.payload; },
    formReset(state) { state.form = initial.form; state.submitError = ''; },
  },
});
export const workbenchActions = workbenchSlice.actions;
