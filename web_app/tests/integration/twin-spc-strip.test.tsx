// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedSites, ResourceTestProviders, type AppRuntime } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { buildTelemetry, computeSpc } from '@/domain/fab-process-control';

import { twinPageUiActions } from '@/twin/twin-page-ui.atom';
import { twinDemoActions } from '@/twin/twin-demo.atom';

import { localeAtom } from '@/state/locale.atom';

// The hardware boundary stays out of this render test: only the inline layout
// SPC strip is measured.
vi.mock('@/twin/twin-viewer', async () => {
  const React = await import('react');
  return {
    // React 19 passes ref as a normal prop; this mock never uses it, so no forwardRef.
    FabViewport: function MockFabViewport() {
      return React.createElement('div', { className: 'scene twin-canvas' });
    },
  };
});

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
let client: AppRuntime<never>;

beforeEach(() => {
  registry.set(localeAtom, { language: 'zh', theme: 'light' });
  localStorage.clear();
  twinDemoActions.playingSet(registry, false);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    addEventListener() {}
    removeEventListener() {}
    close() {}
  });
  client = createTestRuntime(registry);
  seedSites(client, [site]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetTwinUiState(registry); resetTwinPageState(registry); resetTwinDemoState(registry); resetRuntimeState(registry);
});

it('renders split control/spec SPC judgements in the layout inspector strip', () => {
  const view = render(<ResourceTestProviders runtime={client}><TwinPage siteId="site-1" fabId="fab-1" search={{ modal: 'arch' }} /></ResourceTestProviders>);
  // G14: the doubled GPU boundary must actually apply. The real FabViewport would
  // render a <canvas>; the mock renders the scene div only.
  expect(view.container.querySelector('.scene.twin-canvas')).not.toBeNull();
  expect(view.container.querySelector('canvas')).toBeNull();
  const tool = FAB_LAYOUT[0];
  act(() => {
    twinPageUiActions.selectedSet(registry, {
      index: 0, x: tool.x, z: tool.z, width: tool.width, depth: tool.depth, height: tool.height,
      category: tool.category, vendor: tool.vendor, model: tool.model, state: 'running',
    });
    twinPageUiActions.selectionSet(registry, { kind: 'layout', index: 0 });
  });

  const strip = document.querySelector('.twin-spc');
  expect(strip).not.toBeNull();
  const head = strip?.querySelector('.twin-process-head');
  // The strip must render the same control-vs-spec split as twin-inspector.tsx.
  expect(head?.textContent).not.toContain('Nelson 8 Rules In-Spec');
  const telemetry = buildTelemetry(FAB_LAYOUT[0], 0);
  const expected = computeSpc(telemetry.history, telemetry.sensors[0], false);
  expect(expected.insufficientData).toBe(false);
  expect(head?.textContent).toContain(`CONTROL · ${expected.controlStatus}`);
  expect(head?.textContent).toContain(`SPEC · ${expected.specStatus}`);
  expect(strip?.querySelector('.twin-spc-rule')?.textContent).toContain('Implemented Nelson rules');
  expect(strip?.querySelector('.twin-spc-rule')?.textContent).toContain(expected.rule);
  // Sensors and the control chart stay in the strip.
  expect(strip?.querySelectorAll('.twin-spc-sensors > div').length).toBe(telemetry.sensors.length);
  expect(strip?.querySelector('.twin-spc-spark')).not.toBeNull();
});
