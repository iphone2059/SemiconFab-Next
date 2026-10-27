// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TwinPage } from '../../src/features/twin/twin-page';
import { AmhsOhtReadout, AmhsResearchBadge } from '../../src/features/twin/twin-amhs-hud';
import { TwinWaferHud } from '../../src/features/twin/twin-wafer-hud';
import { TwinLocaleProvider } from '../../src/features/twin/twin-i18n';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { resetTwinUiStore, twinUiActions } from '../../src/state/twinUiStore';
import { resetTwinPageStore, twinPageActions } from '../../src/state/twinPageStore';
import { resetTwinDemoStore, twinDemoActions } from '../../src/state/twinDemoStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { useLocaleStore } from '../../src/state/localeStore';
import type { AmhsStats } from '../../src/fab-scene';

// The hardware boundary stays out of these subscription tests: a render counter
// stands in for FabViewport so "did TwinContent rerender?" becomes measurable.
const viewport = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../../src/features/twin/fab-viewer', async () => {
  const React = await import('react');
  return {
    FabViewport: React.forwardRef(function MockFabViewport(_props: unknown, _ref: unknown) {
      viewport.renders += 1;
      return React.createElement('div', { className: 'scene twin-canvas' });
    }),
  };
});

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
const amhs = (patch: Partial<AmhsStats> = {}): AmhsStats => ({ active: 7, total: 24, queued: 3, completed: 12, avgDelivery: 8.5, ...patch });
const hud = (patch: Partial<{ step: string; width: string; toolGroup: string; recipe: string; bay: string; status: string; badge: string }> = {}) => ({
  step: 'Step 1/120', width: '0.8%', toolGroup: 'TG01_LITHO', recipe: 'REC_LITHO_193I',
  bay: 'Lithography Scanner Bay (光刻曝光核心间 (黄光区))', status: 'Navigating...', badge: 'Product A · 120 Steps', ...patch,
});

let client: QueryClient;

beforeEach(() => {
  useLocaleStore.setState({ language: 'zh', theme: 'light' }, true);
  localStorage.clear();
  // Keep the demo clock out of the render counts; these tests measure store slices.
  twinDemoActions.playingSet(false);
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
  viewport.renders = 0;
  vi.unstubAllGlobals();
  resetTwinUiStore(); resetTwinPageStore(); resetTwinDemoStore(); resetRuntimeStore();
});

function renderTwin() {
  render(<QueryClientProvider client={client}><TwinPage fabId="fab-1" search={{ modal: 'arch' }} /></QueryClientProvider>);
}

it('updates the AMHS readout from its own subscription without rerendering TwinContent/FabViewport', () => {
  renderTwin();
  expect(document.querySelector('#bottom-hud-footer')?.textContent).toContain('AMHS OHT 00/24');
  const before = viewport.renders;

  act(() => twinPageActions.amhsSet(amhs()));
  expect(screen.getByText('AMHS OHT 07/24')).toBeTruthy();
  expect(viewport.renders, 'AMHS statistics must not rerender TwinContent/FabViewport').toBe(before);

  act(() => twinPageActions.amhsSet(amhs({ active: 11, completed: 21, avgDelivery: 6.2 })));
  expect(screen.getByText('AMHS OHT 11/24')).toBeTruthy();
  expect(viewport.renders).toBe(before);
});

it('unit-renders the extracted AMHS readouts against the page slice', () => {
  render(<><AmhsOhtReadout /><AmhsResearchBadge /></>);
  expect(screen.getByText('AMHS OHT 00/24')).toBeTruthy();

  act(() => twinPageActions.amhsSet(amhs()));
  expect(screen.getByText('AMHS OHT 07/24')).toBeTruthy();
  expect(document.querySelector('#research-amhs-badge')?.textContent)
    .toBe('AMHS SIMULATED · jobs 12 · avg 8.5 s · active 7/24');

  act(() => twinUiActions.modeSet('research'));
  expect(screen.getByText('JSONL display only')).toBeTruthy();
});

it('keeps 20 Hz wafer-frame updates inside the wafer HUD child', () => {
  renderTwin();
  act(() => twinUiActions.waferOpen());
  const panel = document.querySelector('#wafer-follow-panel');
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('class')).toBe('twin-wafer');
  expect(panel?.getAttribute('aria-label')).toBe('Wafer Follow');
  expect(screen.getByText('正在加载 A/B/C 路线…')).toBeTruthy();
  const opened = viewport.renders;

  act(() => twinPageActions.waferFrameReceived({ product: 'A', index: 0, hud: hud(), completed: false }));
  expect(document.querySelector('#wafer-route-badge')?.textContent).toBe('Product A · 120 Steps');
  expect(viewport.renders, 'wafer frames must not rerender TwinContent/FabViewport').toBe(opened);

  act(() => twinPageActions.waferFrameReceived({
    product: 'B', index: 1, hud: hud({ step: 'Step 2/104', width: '1.9%', badge: 'Product B · 104 Steps' }), completed: true,
  }));
  expect(document.querySelector('#wafer-route-badge')?.textContent).toBe('Product B · 104 Steps');
  expect(viewport.renders).toBe(opened);

  act(() => twinUiActions.waferSpeedSet(16));
  expect(viewport.renders).toBe(opened);
});

it('unit-renders the extracted wafer HUD rows from the page slice', () => {
  render(
    <TwinLocaleProvider>
      <TwinWaferHud
        routesReady
        error=""
        onClose={() => {}}
        onProductChange={() => {}}
        onTogglePlay={() => {}}
        onSpeedChange={() => {}}
        onFollowChange={() => {}}
        onReplay={() => {}}
      />
    </TwinLocaleProvider>,
  );
  expect(document.querySelector('#wafer-step-readout')).toBeNull();

  act(() => twinPageActions.waferFrameReceived({ product: 'A', index: 0, hud: hud(), completed: false }));
  expect(document.querySelector('#wafer-step-readout')?.textContent).toBe('Step 1/120');
  expect(document.querySelector('#wafer-status-readout')?.textContent).toBe('Navigating...');
  expect(document.querySelector('#wafer-progress-bar')?.getAttribute('style')).toBe('width: 0.8%;');
  expect(document.querySelector('#wafer-tg-val')?.textContent).toBe('TG01_LITHO');
  expect(document.querySelector('#wafer-recipe-val')?.textContent).toBe('REC_LITHO_193I');
  expect(document.querySelector('#wafer-bay-val')?.textContent).toBe(hud().bay);

  act(() => twinPageActions.waferFollowSet(false));
  expect(document.querySelector('#wafer-cam-text')?.textContent).toBe('自由视角');
});

it('keeps ~60 Hz tour HUD frames inside the tour card', async () => {
  renderTwin();
  fireEvent.click(document.querySelector('#btn-cinematic-tour') as Element);
  await waitFor(() => expect(document.querySelector('#cinematic-hud')).not.toBeNull());
  expect(document.querySelector('#cinematic-hud')?.getAttribute('class')).toBe('twin-tour-card');
  expect(document.querySelector('#tour-hud-tag')?.textContent).toContain('WAYPOINT 1/5');
  expect(document.querySelector('#tour-hud-timer')?.textContent).toBe('5s');
  expect(document.querySelector('#tour-progress-bar')).not.toBeNull();
  expect(document.querySelectorAll('#tour-dots-container [role="tab"]')).toHaveLength(5);

  // The first RAF tick re-applies waypoint 0; measure only after that settles.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const settled = viewport.renders;

  // The dwell countdown changes timer/progress at ~100 ms cadence once the tween ends.
  await waitFor(() => expect(document.querySelector('#tour-hud-timer')?.textContent).not.toBe('5s'), { timeout: 8000 });
  expect(viewport.renders, 'tour HUD ticks must not rerender TwinContent/FabViewport').toBe(settled);
});
