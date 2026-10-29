// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { sitesQueryOptions } from '@/api/sites.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { buildTelemetry, computeSpc } from '@/domain/fab-process-control';

import { twinPageActions } from '@/twin/twin-page.atom';
import { twinDemoActions } from '@/twin/twin-demo.atom';

import { localeAtom } from '@/state/locale.atom';

// The hardware boundary stays out of this render test: only the inline layout
// SPC strip is measured.
vi.mock('../../src/features/twin/fab-viewer', async () => {
  const React = await import('react');
  return {
    FabViewport: React.forwardRef(function MockFabViewport(_props: unknown, _ref: unknown) {
      return React.createElement('div', { className: 'scene twin-canvas' });
    }),
  };
});

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
let client: QueryClient;

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
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  resetTwinUiState(registry); resetTwinPageState(registry); resetTwinDemoState(registry); resetRuntimeState(registry);
});

it('renders split control/spec SPC judgements in the layout inspector strip', () => {
  render(<QueryClientProvider client={client}><TwinPage fabId="fab-1" search={{ modal: 'arch' }} /></QueryClientProvider>);
  const tool = FAB_LAYOUT[0];
  act(() => {
    twinPageActions.selectedSet(registry, {
      index: 0, x: tool.x, z: tool.z, width: tool.width, depth: tool.depth, height: tool.height,
      category: tool.category, vendor: tool.vendor, model: tool.model, state: 'running',
    });
    twinPageActions.selectionSet(registry, { kind: 'layout', index: 0 });
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
