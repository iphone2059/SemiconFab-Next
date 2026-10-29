// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedSites, readEquipmentStatus, ResourceTestProviders } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { twinPageAtom } from '@/twin/twin-page.atom';



/**
 * A02: the parent page consumes a frequency-controlled projection. Raw SSE cache
 * writes go to an isolated bridge child (which renders nothing) and reach the
 * page through the 100 ms batcher, so TwinContent/FabViewport never renders once
 * per server frame.
 */

const viewport = vi.hoisted(() => ({ renders: 0 }));
vi.mock('@/twin/twin-viewer', async () => {
  const React = await import('react');
  return {
    // React 19 passes ref as a normal prop; these mocks never use it, so no forwardRef.
    FabViewport: function MockFabViewport() {
      viewport.renders += 1;
      return React.createElement('div', { className: 'scene twin-canvas' });
    },
  };
});

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };

class CapturingEventSource {
  static instances: CapturingEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    CapturingEventSource.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const frame = (sequence: number, state: string, generatedAt: string): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId: 'fab-1',
  generatedAt,
  sequence,
  epoch: 1,
  tools: FAB_LAYOUT.map((_, index) => ({ state: index === 0 ? state : 'running' })),
});

const send = (source: CapturingEventSource, value: unknown) => {
  act(() => { source.onmessage?.({ data: JSON.stringify(value) }); });
};
const flushProjection = () => act(async () => { await vi.advanceTimersByTimeAsync(101); });

afterEach(() => {
  cleanup();
  viewport.renders = 0;
  CapturingEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetTwinUiState(registry); resetTwinPageState(registry); resetRuntimeState(registry); resetTwinDemoState(registry);
});

it('A02: SSE frames publish through one throttled projection instead of rendering per frame', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = createTestRuntime(registry);
  seedSites(client, [site]);
  render(
    <ResourceTestProviders runtime={client}>
      <TwinPage fabId="fab-1" search={{ modal: 'arch' }} />
    </ResourceTestProviders>,
  );

  await waitFor(() => expect(viewport.renders).toBeGreaterThan(0));
  await waitFor(() => expect(CapturingEventSource.instances.length).toBeGreaterThan(0));
  // Let the mount-time stores/effects settle before counting renders.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  // The page defaults to the DEMO clock; this test measures the SSE projection,
  // so stop the 1600 ms demo tick before counting renders. Without this a slow
  // (parallel-worker) run can legitimately tick the demo clock mid-assertion and
  // add an unrelated FabViewport render.
  await act(async () => { twinUiActions.sourceSet(registry, 'sse-live'); });
  const source = CapturingEventSource.instances.find((value) => value.url.includes('/equipment-status/stream'));
  if (!source) throw new Error('missing equipment-status stream');
  // Deterministically drive the 100 ms coalescer; wall-clock sleeps are flaky under parallel Vitest workers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const projectedTimes: string[] = [];
  let previous = registry.get(twinPageAtom);
  const unsubscribe = registry.subscribe(twinPageAtom, next => {
    const current = next.statusFeed?.updatedAt;
    if (current !== undefined && current !== previous.statusFeed?.updatedAt) projectedTimes.push(current);
    previous = next;
  });
  const before = viewport.renders;

  send(source, frame(1, 'down', '2026-10-27T00:00:01Z'));
  // The cache and the bridge child observed the raw frame...
  expect(readEquipmentStatus(client, 'site-1', 'fab-1')?.sequence).toBe(1);
  // ...but TwinContent/FabViewport has not rendered for it yet.
  expect(viewport.renders, 'a raw SSE cache write must not rerender TwinContent').toBe(before);
  expect(projectedTimes).toEqual([]);

  await flushProjection();
  expect(projectedTimes).toEqual(['2026-10-27T00:00:01Z']);
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down');
  expect(registry.get(twinPageAtom).statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:01Z', stale: false });

  // Two frames inside one 100 ms window coalesce into a single projection publish.
  send(source, frame(2, 'idle', '2026-10-27T00:00:02Z'));
  send(source, frame(3, 'maint', '2026-10-27T00:00:03Z'));
  await flushProjection();
  // Count authoritative coalesced projection commits, not implementation-specific
  // React renders that may be batched differently across concurrent workers.
  expect(projectedTimes).toEqual(['2026-10-27T00:00:01Z', '2026-10-27T00:00:03Z']);
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('maint');
  expect(registry.get(twinPageAtom).statusFeed?.updatedAt).toBe('2026-10-27T00:00:03Z');
  unsubscribe();
});
