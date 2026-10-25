import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, it } from 'vitest';
import { OriginalInspector } from '../src/twin-inspector';
import { ORIGINAL_TWIN_UI } from '../src/original-twin-data';
import { TwinLocaleProvider } from '../src/twin-i18n';
import { localeActions } from '../src/store/localeSlice';
import { store } from '../src/store/store';
import { twinDemoActions } from '../src/store/twinDemoSlice';
import { createProcessMesJob } from '../src/process-control';

it('renders clock-owned FDC values and source MES identifiers across ticks and locale switches', () => {
  const equipment = ORIGINAL_TWIN_UI.equipment[0];
  const render = () => renderToStaticMarkup(<Provider store={store}><TwinLocaleProvider><OriginalInspector
    selection={{ kind: 'reference', id: equipment.id }} states={store.getState().twinDemo.keys}
    onClose={() => {}} onManualKey={() => {}} /></TwinLocaleProvider></Provider>);
  const before = render();
  expect(before).toContain(createProcessMesJob(equipment, 1000).recipeId);
  store.dispatch(twinDemoActions.tick());
  const value = store.getState().twinDemo.telemetry[equipment.id].sensors[0].value.toFixed(2);
  const after = render();
  expect(after).toContain(value);
  expect(after).not.toBe(before);
  store.dispatch(localeActions.languageToggled());
  expect(render()).toContain(value);
});
