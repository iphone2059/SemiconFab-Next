// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { TwinPage } from '../../src/features/twin/twin-page';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { equipmentStatusQueryKey } from '../../src/api/queries/equipment.queries';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '../../src/domain/fab/fab-layout';
import { resetTwinUiStore, twinUiActions } from '../../src/features/twin/state/twinUiStore';
import { resetTwinPageStore, useTwinPageStore } from '../../src/features/twin/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore } from '../../src/features/twin/state/twinDemoStore';
import type { EquipmentStatusSnapshot } from '../../src/realtime/equipment-status/protocol';

/**
 * FAB A→B→A scope cycle across the real TwinPage pipeline: the Query cache,
 * the per-scope ordering gate, the SSE subscriptions and the page projection
 * must stay isolated, and a re-entered FAB must resume from its accepted
 * cache/ordering high-water instead of regressing. Also pins that the old
 * EventSource generation is detached (no stale-generation async callback can
 * publish into the new FAB).
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

const site = {
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'test',
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
    { fabId: 'fab-b', code: 'FAB-B' },
  ],
};

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

const tools = (overrides: Record<number, FabToolState> = {}, fallback: FabToolState = 'running') =>
  FAB_LAYOUT.map((_, index) => ({ state: overrides[index] ?? fallback }));

const frame = (
  fabId: string,
  sequence: number,
  generatedAt: string,
  patch: Partial<EquipmentStatusSnapshot> = {},
): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId,
  generatedAt,
  sequence,
  epoch: 1,
  tools: tools(),
  ...patch,
});

const streamUrl = (fabId: string) => `/api/v1/sites/site-1/fabs/${fabId}/equipment-status/stream`;

async function streamFor(fabId: string, expectedCount: number): Promise<CapturingEventSource> {
  await waitFor(() =>
    expect(CapturingEventSource.instances.filter((source) => source.url === streamUrl(fabId))).toHaveLength(expectedCount));
  return CapturingEventSource.instances.filter((source) => source.url === streamUrl(fabId))[expectedCount - 1];
}

const send = (source: CapturingEventSource, value: unknown) => {
  act(() => { source.onmessage?.({ data: JSON.stringify(value) }); });
};
const flushProjection = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)); });
const cached = (client: QueryClient, fabId: string) =>
  client.getQueryData<EquipmentStatusSnapshot>(equipmentStatusQueryKey('site-1', fabId));

afterEach(() => {
  cleanup();
  viewport.renders = 0;
  CapturingEventSource.instances = [];
  vi.unstubAllGlobals();
  resetTwinUiStore(); resetTwinPageStore(); resetRuntimeStore(); resetTwinDemoStore();
});

it('keeps Query cache, ordering and SSE generation isolated across A→B→A', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
  const view = render(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  const sourceA = await streamFor('fab-a', 1);
  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-a'));
  // Keep the demo clock out of the projection latency budget.
  act(() => twinUiActions.sourceSet('sse-live'));
  send(sourceA, frame('fab-a', 5, '2026-10-27T00:00:05Z', { tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(cached(client, 'fab-a')?.sequence).toBe(5));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down'));

  // A→B: the FAB-scoped query keys, streams and projections are independent.
  view.rerender(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-b" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-b'));
  const sourceB = await streamFor('fab-b', 1);
  expect(cached(client, 'fab-b')).toBeUndefined();
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  // The unmounted A subscription is detached, so no late A frame can be delivered.
  expect(sourceA.onmessage).toBeNull();

  send(sourceB, frame('fab-b', 1, '2026-10-27T00:00:20Z', { tools: tools({ 0: 'idle' }) }));
  await waitFor(() => expect(cached(client, 'fab-b')?.sequence).toBe(1));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('idle'));
  expect(cached(client, 'fab-a')?.sequence).toBe(5);

  // B→A: re-enter A with a fresh SSE generation whose ordering resumes from A's
  // accepted cache entry (sequence 5), while B stays untouched.
  view.rerender(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-a'));
  const sourceA2 = await streamFor('fab-a', 2);
  expect(sourceB.onmessage).toBeNull();
  expect(cached(client, 'fab-b')?.sequence).toBe(1);

  // Reconnect replay + older frame of the re-entered FAB: dropped by the gate.
  send(sourceA2, frame('fab-a', 5, '2026-10-27T00:00:05Z', { tools: tools({ 0: 'maint' }) }));
  send(sourceA2, frame('fab-a', 4, '2026-10-27T00:00:04Z', { tools: tools({ 0: 'maint' }) }));
  await flushProjection();
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  expect(cached(client, 'fab-a')?.tools[0].state).toBe('down');
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down');

  // A crossed-FAB frame on A's stream marks the feed stale but never writes the cache.
  send(sourceA2, frame('fab-b', 6, '2026-10-27T00:00:06Z', { tools: tools({ 0: 'maint' }) }));
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  expect(useTwinPageStore.getState().statusFeed?.stale).toBe(true);

  // A genuinely newer A frame recovers LIVE and advances only A's cache.
  send(sourceA2, frame('fab-a', 6, '2026-10-27T00:00:06Z', { tools: tools({ 0: 'maint' }) }));
  await waitFor(() => expect(cached(client, 'fab-a')?.sequence).toBe(6));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('maint'));
  expect(useTwinPageStore.getState().statusFeed?.stale).toBe(false);
  expect(cached(client, 'fab-b')?.sequence).toBe(1);
  expect(cached(client, 'fab-b')?.tools[0].state).toBe('idle');
  // A's accepted layout is complete: the projection never fell back to defaults.
  expect(useTwinPageStore.getState().liveToolStates).toHaveLength(FAB_TOOL_STATES.length);
  client.clear();
});
