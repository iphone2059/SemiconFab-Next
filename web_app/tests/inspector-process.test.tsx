// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { OriginalInspector } from '../src/features/twin/twin-inspector';
import { ORIGINAL_TWIN_UI } from '../src/original-twin-data';
import { TwinLocaleProvider } from '../src/features/twin/twin-i18n';
import { localeActions, resetLocaleStore } from '../src/state/localeStore';
import { resetTwinDemoStore, twinDemoActions, useTwinDemoStore } from '../src/state/twinDemoStore';
import { createProcessMesJob } from '../src/process-control';

beforeEach(() => {
  resetTwinDemoStore();
  resetLocaleStore();
});
afterEach(cleanup);

it('renders clock-owned FDC values and source MES identifiers across ticks and locale switches', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  // A client render (unlike static markup) reads the live Zustand snapshot, so
  // the FDC telemetry below reflects ticks applied after mounting.
  const { container } = render(<TwinLocaleProvider><OriginalInspector
    selection={{ kind: 'reference', id: equipment.id }} states={useTwinDemoStore.getState().keys}
    onClose={() => {}} onManualKey={() => {}} /></TwinLocaleProvider>);
  expect(container.innerHTML).toContain(createProcessMesJob(equipment, 1000).recipeId);
  const before = container.innerHTML;
  act(() => { twinDemoActions.tick(); });
  const value = useTwinDemoStore.getState().telemetry[equipment.id].sensors[0].value.toFixed(2);
  expect(container.innerHTML).toContain(value);
  expect(container.innerHTML).not.toBe(before);
  act(() => { localeActions.preferencesSet({ language: 'zh', theme: 'light' }); });
  expect(container.innerHTML).toContain(value);
});
