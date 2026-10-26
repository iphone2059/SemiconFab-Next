import { configureStore } from '@reduxjs/toolkit';
import { twinDemoSlice } from './twinDemoSlice';
import { twinPageSlice, twinUiSlice } from './twinUiSlice';
import { workbenchSlice } from './workbenchSlice';
import { catalogSlice } from './catalogSlice';
import { localeSlice } from './localeSlice';
import { runtimeSlice } from './runtimeSlice';

// M2 removed RTK Query entirely: every HTTP endpoint is now a TanStack Query
// module under src/api/queries. Redux remains temporarily for client UI state
// only and is deleted in M2b/M6 when the Zustand stores take over (ARCH-02/05).
const HIGH_FREQUENCY_ACTIONS = [
  'twinPage/tourTick',
  'twinPage/liveSnapshotReceived',
  'twinPage/amhsSet',
  'twinUi/researchAdvance',
  'twinDemo/tick',
  'runtime/viewerHoverReceived',
  'twinPage/waferFrameAdvanced',
];
const devtoolsEnabled = (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== false;

export const store = configureStore({
  reducer: {
    twinUi: twinUiSlice.reducer,
    twinDemo: twinDemoSlice.reducer,
    twinPage: twinPageSlice.reducer,
    workbench: workbenchSlice.reducer,
    catalog: catalogSlice.reducer,
    locale: localeSlice.reducer,
    runtime: runtimeSlice.reducer,
  },
  // Scene objects and frame-frequency telemetry never enter the store. Large,
  // serializable arrays are skipped by the development-only immutable check.
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({
    serializableCheck: {
      warnAfter: 128,
      ignoredActions: HIGH_FREQUENCY_ACTIONS,
      ignoredPaths: ['twinPage.liveToolStates', 'twinDemo.states', 'twinDemo.keys', 'twinDemo.referenceLights'],
    },
    immutableCheck: false,
  }),
  devTools: devtoolsEnabled ? {
    maxAge: 50,
    actionsDenylist: HIGH_FREQUENCY_ACTIONS,
  } : false,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type AppStore = typeof store;
