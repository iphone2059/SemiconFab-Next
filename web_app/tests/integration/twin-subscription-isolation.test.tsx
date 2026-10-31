// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedResearchEvents, seedSites, ResourceTestProviders, type AppRuntime } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { AmhsOhtReadout, AmhsResearchBadge } from '@/twin/twin-amhs-hud';
import { TwinWaferHud } from '@/twin/twin-wafer-hud';
import { TwinYmsPanel } from '@/twin/twin-yms';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { createMesJob } from '@/domain/fab-process-control';
import { TwinLocaleProvider } from '@/twin/twin-i18n';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { twinPageActions } from '@/twin/twin-page.atom';
import { twinPageUiActions } from '@/twin/twin-page-ui.atom';
import { twinWaferActions } from '@/twin/twin-wafer.atom';
import { twinResearchAtom, twinResearchActions } from '@/twin/twin-research.atom';
import { twinYmsActions } from '@/twin/twin-yms.atom';
import { twinAmhsActions } from '@/twin/twin-amhs.atom';
import { twinDemoActions } from '@/twin/twin-demo.atom';

import { localeAtom } from '@/state/locale.atom';
import { viewerActions } from '@/state/viewer.atom';
import type { AmhsStats } from '@/contracts/scene.port';

// The hardware boundary stays out of these subscription tests: a render counter
// stands in for FabViewport so "did TwinContent rerender?" becomes measurable.
const viewport = vi.hoisted(() => ({ renders: 0, mounts: 0, unmounts: 0 }));
vi.mock('@/twin/twin-viewer', async () => {
  const React = await import('react');
  return {
    // React 19 passes ref as a normal prop; this mock never uses it, so no forwardRef.
    FabViewport: function MockFabViewport() {
      viewport.renders += 1;
      React.useEffect(() => {
        viewport.mounts += 1;
        return () => { viewport.unmounts += 1; };
      }, []);
      return React.createElement('div', { className: 'scene twin-canvas' });
    },
  };
});

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
const amhs = (patch: Partial<AmhsStats> = {}): AmhsStats => ({ active: 7, total: 24, queued: 3, completed: 12, avgDelivery: 8.5, ...patch });
const hud = (patch: Partial<{ step: string; width: string; toolGroup: string; recipe: string; bay: string; status: string; badge: string }> = {}) => ({
  step: 'Step 1/120', width: '0.8%', toolGroup: 'TG01_LITHO', recipe: 'REC_LITHO_193I',
  bay: 'Lithography Scanner Bay (光刻曝光核心间 (黄光区))', status: 'Navigating...', badge: 'Product A · 120 Steps', ...patch,
});

let client: AppRuntime<never>;

beforeEach(() => {
  registry.set(localeAtom, { language: 'zh', theme: 'light' });
  localStorage.clear();
  // Keep the demo clock out of the render counts; these tests measure store slices.
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
  viewport.renders = 0;
  viewport.mounts = 0;
  viewport.unmounts = 0;
  vi.unstubAllGlobals();
  resetTwinUiState(registry); resetTwinPageState(registry); resetTwinDemoState(registry); resetRuntimeState(registry);
});

function renderTwin() {
  render(<ResourceTestProviders runtime={client}><TwinPage siteId="site-1" fabId="fab-1" search={{ modal: 'arch' }} /></ResourceTestProviders>);
}

it('keeps FabViewport mounted while the Wafer runtime is replaced by a viewer epoch', async () => {
  renderTwin();
  await waitFor(() => expect(viewport.mounts).toBe(1));
  const rendersBeforeEpoch = viewport.renders;
  act(() => viewerActions.viewerMounted(registry, 'viewer-epoch-next'));
  await waitFor(() => expect(viewport.renders).toBeGreaterThan(rendersBeforeEpoch));
  expect(viewport.mounts).toBe(1);
  expect(viewport.unmounts).toBe(0);
  expect(document.querySelector('.scene.twin-canvas')).not.toBeNull();
});
it('updates the AMHS readout from its own subscription without rerendering TwinContent/FabViewport', () => {
  renderTwin();
  expect(document.querySelector('#bottom-hud-footer')?.textContent).toContain('AMHS OHT 00/24');
  const before = viewport.renders;

  act(() => twinAmhsActions.amhsSet(registry, amhs()));
  expect(screen.getByText('AMHS OHT 07/24')).toBeTruthy();
  expect(viewport.renders, 'AMHS statistics must not rerender TwinContent/FabViewport').toBe(before);

  act(() => twinAmhsActions.amhsSet(registry, amhs({ active: 11, completed: 21, avgDelivery: 6.2 })));
  expect(screen.getByText('AMHS OHT 11/24')).toBeTruthy();
  expect(viewport.renders).toBe(before);
});

it('unit-renders the extracted AMHS readouts against the page slice', () => {
  render(<><AmhsOhtReadout /><AmhsResearchBadge /></>);
  expect(screen.getByText('AMHS OHT 00/24')).toBeTruthy();

  act(() => twinAmhsActions.amhsSet(registry, amhs()));
  expect(screen.getByText('AMHS OHT 07/24')).toBeTruthy();
  expect(document.querySelector('#research-amhs-badge')?.textContent)
    .toBe('AMHS SIMULATED · jobs 12 · avg 8.5 s · active 7/24');

  act(() => twinUiActions.modeSet(registry, 'research'));
  expect(screen.getByText('JSONL display only')).toBeTruthy();
});

it('keeps 20 Hz wafer-frame updates inside the wafer HUD child', () => {
  renderTwin();
  act(() => twinWaferActions.projectionSet(registry, { active: true, playing: true, speed: 1, product: 'A', index: 0, completed: false }));
  const panel = document.querySelector('#wafer-follow-panel');
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('class')).toBe('twin-wafer');
  expect(panel?.getAttribute('aria-label')).toBe('Wafer Follow');
  expect(screen.getByText('正在加载 A/B/C 路线…')).toBeTruthy();
  const opened = viewport.renders;

  act(() => twinWaferActions.hudSet(registry, hud()));
  expect(document.querySelector('#wafer-route-badge')?.textContent).toBe('Product A · 120 Steps');
  expect(viewport.renders, 'wafer frames must not rerender TwinContent/FabViewport').toBe(opened);

  act(() => {
    twinWaferActions.projectionSet(registry, { active: true, playing: false, speed: 16, product: 'B', index: 1, completed: true });
    twinWaferActions.hudSet(registry, hud({ step: 'Step 2/104', width: '1.9%', badge: 'Product B · 104 Steps' }));
  });
  expect(document.querySelector('#wafer-route-badge')?.textContent).toBe('Product B · 104 Steps');
  expect(viewport.renders).toBe(opened);

  act(() => twinWaferActions.projectionSet(registry, { active: true, playing: false, speed: 16, product: 'B', index: 1, completed: true }));
  expect(viewport.renders).toBe(opened);
});

it('updates Research HUD and footer without rerendering the FabViewport on unchanged tool states', async () => {
  seedResearchEvents(client, [
    { timestamp_sec: 0, event_type: 'wip_sample', payload: { wip_count: 5 } },
    { timestamp_sec: 20, event_type: 'wip_sample', payload: { wip_count: 6 } },
  ].map(event => JSON.stringify(event)).join('\n'));
  renderTwin();
  fireEvent.change(document.querySelector('#mode-select')!, { target: { value: 'research' } });
  await waitFor(() => expect(document.querySelector('#research-wip-val')?.textContent).toBe('6 lots'));
  const before = viewport.renders;
  const current = registry.get(twinResearchAtom);
  expect(current.snapshot).toBeDefined();
  act(() => twinResearchActions.projectionSet(registry, {
    ...current,
    timeSec: current.timeSec + 0.1,
    snapshot: { ...current.snapshot!, wip: 9 },
  }));
  expect(document.querySelector('#research-wip-val')?.textContent).toBe('9 lots');
  expect(document.querySelector('#bottom-hud-footer')?.textContent).toContain('REPLAY · WIP 9');
  expect(viewport.renders).toBe(before);
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

  act(() => twinWaferActions.hudSet(registry, hud()));
  expect(document.querySelector('#wafer-step-readout')?.textContent).toBe('Step 1/120');
  expect(document.querySelector('#wafer-status-readout')?.textContent).toBe('Navigating...');
  expect(document.querySelector('#wafer-progress-bar')?.getAttribute('style')).toBe('width: 0.8%;');
  expect(document.querySelector('#wafer-tg-val')?.textContent).toBe('TG01_LITHO');
  expect(document.querySelector('#wafer-recipe-val')?.textContent).toBe('REC_LITHO_193I');
  expect(document.querySelector('#wafer-bay-val')?.textContent).toBe(hud().bay);

  act(() => twinWaferActions.followSet(registry, false));
  expect(document.querySelector('#wafer-cam-text')?.textContent).toBe('自由视角');
});

it('keeps sidebar, OEM dialog, archive query and inspector-MES branches out of TwinContent/FabViewport', () => {
  renderTwin();
  const settled = viewport.renders;

  act(() => twinPageUiActions.sidebarQuerySet(registry, 'ASML'));
  // The sidebar owns its slice, so the filtered query updates without touching the page.
  expect((document.querySelector('#search-input') as HTMLInputElement).value).toBe('ASML');
  expect(viewport.renders, 'sidebar branch must not rerender TwinContent/FabViewport').toBe(settled);

  act(() => {
    twinPageUiActions.oemDialogQuerySet(registry, 'ASML');
    twinPageUiActions.oemDialogSegmentSet(registry, 'Lithography');
    twinPageUiActions.oemDialogVendorSet(registry, 'ASML');
    twinPageUiActions.archQuerySet(registry, 'xray');
    twinPageActions.inspectorMesSet(registry, { id: FAB_LAYOUT[0].recordId, job: createMesJob(FAB_LAYOUT[0], 0, 1000) });
  });
  expect(viewport.renders, 'OEM/archive/inspector-MES branches must not rerender TwinContent/FabViewport').toBe(settled);
});

it('keeps YMS hover, die-map inputs and the header yield pill out of TwinContent/FabViewport', () => {
  renderTwin();
  fireEvent.click(document.querySelector('.twin-yms-toggle') as Element);
  expect(document.querySelector('.twin-yms')).not.toBeNull();
  expect(document.querySelector('.twin-wafer-hover')?.textContent).toMatch(/^300 mm · \d+ dies · Notch 180°$/);
  const opened = viewport.renders;

  // Cross-die hover lands in the page store at pointer frequency. A14: only the
  // YMS child may rerender; TwinContent and its FabViewport stay untouched.
  for (const die of [{ r: 3, c: 4, bin: 1 as const }, { r: 7, c: 8, bin: 2 as const }, { r: 11, c: 12, bin: 3 as const }]) {
    act(() => twinYmsActions.ymsHoverDieSet(registry, die));
    expect(document.querySelector('.twin-wafer-hover')?.textContent).toBe(`Die [R${die.r}, C${die.c}] · ${die.bin === 1 ? 'Pass (Prime Die)' : die.bin === 2 ? 'Bin 2: Parametric Fail' : 'Bin 3: Functional Hard Fail'}`);
    expect(viewport.renders, 'YMS hover must not rerender TwinContent/FabViewport').toBe(opened);
  }

  // Die-area / defect-model inputs are child-owned as well.
  const dieArea = document.querySelector('.twin-yield-models input[type="range"]') as HTMLInputElement;
  act(() => { fireEvent.change(dieArea, { target: { value: '250' } }); });
  expect(screen.getByText('250 mm²')).toBeTruthy();
  expect(viewport.renders, 'YMS die-area input must not rerender TwinContent/FabViewport').toBe(opened);

  // The header yield pill now owns the cascading-yield subscription; changing a
  // yield input still updates the subbar value without touching the viewport.
  const yieldBefore = document.querySelector('#header-yield-val')?.textContent;
  act(() => twinYmsActions.ymsYieldInputSet(registry, { purity: 5, health: 90, lagTime: 1 }));
  expect(document.querySelector('#header-yield-val')?.textContent).not.toBe(yieldBefore);
  expect(viewport.renders, 'yield inputs must not rerender TwinContent/FabViewport').toBe(opened);

  // A genuine page-level field (dialog mode) still rerenders TwinContent and the viewport.
  act(() => twinPageUiActions.infoDialogSet(registry, 'database'));
  expect(document.querySelector('#oem-database-modal')).not.toBeNull();
  expect(viewport.renders, 'page-level store fields must still rerender the page').toBeGreaterThan(opened);
});

it('unit-renders the extracted YMS panel against the page slice', () => {
  const toolStates = Array.from({ length: 121 }, () => 'running' as const);
  render(
    <TwinLocaleProvider>
      <TwinYmsPanel toolStates={toolStates} />
    </TwinLocaleProvider>,
  );
  expect(document.querySelector('.twin-wafer-hover')?.textContent).toMatch(/^300 mm · \d+ dies · Notch 180°$/);
  expect(document.querySelector('.twin-stdf')?.textContent).toContain('TotalDies=');

  act(() => twinYmsActions.ymsHoverDieSet(registry, { r: 5, c: 6, bin: 5 }));
  expect(document.querySelector('.twin-wafer-hover')?.textContent).toBe('Die [R5, C6] · Bin 5: Interconnect Short/Open');

  act(() => twinYmsActions.ymsRandomize(registry, 'ring'));
  expect(document.querySelector('.twin-yms-pattern b')?.textContent).toBe('Edge-Ring Excursion');
  expect(document.querySelector('.twin-yield-models')?.textContent).toContain('Cluster α');

  act(() => twinYmsActions.ymsTabSet(registry, 'yield'));
  expect(document.querySelector('.twin-yield-view')).not.toBeNull();
  expect(document.querySelector('.twin-yield-summary')?.textContent).toContain('OVERALL FAB YIELD');
  expect(document.querySelector('.twin-yield-summary')?.textContent).toContain('BOTTLENECK');
  expect(document.querySelectorAll('.twin-yield-bars > div').length).toBeGreaterThan(0);
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
