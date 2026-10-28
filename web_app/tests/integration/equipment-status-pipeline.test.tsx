// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { TwinPage } from '../../src/features/twin/twin-page';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { equipmentStatusQueryKey } from '../../src/api/queries/equipment.queries';
import { FAB_LAYOUT } from '../../src/domain/fab/fab-layout';
import type { EquipmentStatusSnapshot } from '../../src/realtime/equipment-status/protocol';
import { resetTwinUiStore, twinUiActions } from '../../src/features/twin/state/twinUiStore';
import { resetTwinPageStore, useTwinPageStore } from '../../src/features/twin/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore } from '../../src/features/twin/state/twinDemoStore';

/**
 * A02: the parent page consumes a frequency-controlled projection. Raw SSE cache
 * writes go to an isolated bridge child (which renders nothing) and reach the
 * page through the 100 ms batcher, so TwinContent/FabViewport never renders once
 * per server frame.
 */

const viewport = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../../src/features/twin/fab-viewer', async () => {
  const React = await import('react');
  return {
    FabViewport: React.forwardRef(function MockFabViewport() {
      viewport.renders += 1;
      return React.createElement('div', { className: 'scene twin-canvas' });
    }),
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
  resetTwinUiStore(); resetTwinPageStore(); resetRuntimeStore(); resetTwinDemoStore();
});

it('A02: SSE frames publish through one throttled projection instead of rendering per frame', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
  render(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-1" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(viewport.renders).toBeGreaterThan(0));
  await waitFor(() => expect(CapturingEventSource.instances.length).toBeGreaterThan(0));
  // Let the mount-time stores/effects settle before counting renders.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  // The page defaults to the DEMO clock; this test measures the SSE projection,
  // so stop the 1600 ms demo tick before counting renders. Without this a slow
  // (parallel-worker) run can legitimately tick the demo clock mid-assertion and
  // add an unrelated FabViewport render.
  await act(async () => { twinUiActions.sourceSet('sse-live'); });
  const source = CapturingEventSource.instances.find((value) => value.url.includes('/equipment-status/stream'));
  if (!source) throw new Error('missing equipment-status stream');
  // Deterministically drive the 100 ms coalescer; wall-clock sleeps are flaky under parallel Vitest workers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const before = viewport.renders;

  send(source, frame(1, 'down', '2026-10-27T00:00:01Z'));
  // The cache and the bridge child observed the raw frame...
  expect(client.getQueryData<EquipmentStatusSnapshot>(equipmentStatusQueryKey('site-1', 'fab-1'))?.sequence).toBe(1);
  // ...but TwinContent/FabViewport has not rendered for it yet.
  expect(viewport.renders, 'a raw SSE cache write must not rerender TwinContent').toBe(before);

  await flushProjection();
  expect(viewport.renders).toBe(before + 1);
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down');
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:01Z', stale: false });

  // Two frames inside one 100 ms window coalesce into a single projection publish.
  send(source, frame(2, 'idle', '2026-10-27T00:00:02Z'));
  send(source, frame(3, 'maint', '2026-10-27T00:00:03Z'));
  await flushProjection();
  expect(viewport.renders).toBe(before + 2);
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('maint');
  expect(useTwinPageStore.getState().statusFeed?.updatedAt).toBe('2026-10-27T00:00:03Z');
  client.clear();
});
