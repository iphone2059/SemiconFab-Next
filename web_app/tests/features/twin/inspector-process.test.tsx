// @vitest-environment jsdom
import { resetLocaleState, resetTwinDemoState } from '../../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { OriginalInspector } from '@/twin/twin-inspector';
import { ORIGINAL_TWIN_UI } from '@/domain/original-twin-data';
import { TwinLocaleProvider } from '@/twin/twin-i18n';
import { localeActions } from '@/state/locale.atom';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import { createProcessMesJob } from '@/domain/fab-process-control';

const { registry, render } = createAtomTestScope();
beforeEach(() => {
  resetTwinDemoState(registry);
  resetLocaleState(registry);
});
afterEach(cleanup);

it('renders clock-owned FDC values and source MES identifiers across ticks and locale switches', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  // A client render (unlike static markup) reads the live Effect Atom snapshot, so
  // the FDC telemetry below reflects ticks applied after mounting.
  const { container } = render(<TwinLocaleProvider><OriginalInspector
    selection={{ kind: 'reference', id: equipment.id }} states={registry.get(twinDemoAtom).keys}
    onClose={() => {}} onManualKey={() => {}} /></TwinLocaleProvider>);
  expect(container.innerHTML).toContain(createProcessMesJob(equipment, 1000).recipeId);
  const before = container.innerHTML;
  act(() => { twinDemoActions.tick(registry); });
  const value = registry.get(twinDemoAtom).telemetry[equipment.id].sensors[0].value.toFixed(2);
  expect(container.innerHTML).toContain(value);
  expect(container.innerHTML).not.toBe(before);
  act(() => { localeActions.preferencesSet(registry, { language: 'zh', theme: 'light' }); });
  expect(container.innerHTML).toContain(value);
});

function renderInspector(equipmentId: string) {
  return render(<TwinLocaleProvider><OriginalInspector
    selection={{ kind: 'reference', id: equipmentId }} states={registry.get(twinDemoAtom).keys}
    onClose={() => {}} onManualKey={() => {}} /></TwinLocaleProvider>);
}

function setHistory(equipmentId: string, history: number[]): void {
  registry.update(twinDemoAtom, (state) => ({
    ...state,
    telemetry: { ...state.telemetry, [equipmentId]: { ...state.telemetry[equipmentId], history } },
  }));
}

it('renders control status and spec status separately with the implemented-rule note', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  const telemetry = registry.get(twinDemoAtom).telemetry[equipment.id];
  const sensor = telemetry.sensors[0];
  const tolerance = (sensor.max - sensor.min) * 0.45;
  setHistory(equipment.id, Array.from({ length: 25 }, (_, index) =>
    (sensor.min + sensor.max) / 2 + (index % 2 === 0 ? -1 : 1) * tolerance * 0.1));
  const { container } = renderInspector(equipment.id);
  const text = container.textContent ?? '';
  expect(text).toContain('CONTROL · IN CONTROL');
  expect(text).toContain('SPEC · IN SPEC');
  expect(text).toContain('Implemented Nelson rules');
  expect(text).not.toContain('Nelson 8 Rules In-Spec');
  expect(text).not.toContain('PASS:');
});

it('renders an explicit insufficient-data state instead of fabricated healthy metrics', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  setHistory(equipment.id, [100, 100, 100]);
  const { container } = renderInspector(equipment.id);
  const text = container.textContent ?? '';
  expect(text).toContain('CONTROL · INSUFFICIENT DATA');
  expect(text).toContain('SPEC · INSUFFICIENT DATA');
  expect(text).toContain('Insufficient data / 数据不足');
  expect(text).not.toContain('Nelson 8 Rules In-Spec');
});

it('does not report a spec pass for a stable but off-spec history', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  setHistory(equipment.id, Array.from({ length: 25 }, () => 100));
  const { container } = renderInspector(equipment.id);
  const text = container.textContent ?? '';
  expect(text).toContain('CONTROL · IN CONTROL');
  expect(text).toContain('SPEC · OUT OF SPEC');
  expect(text).not.toContain('Nelson 8 Rules In-Spec');
});
