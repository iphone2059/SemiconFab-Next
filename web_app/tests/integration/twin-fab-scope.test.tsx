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
import { createMesJob } from '../../src/domain/fab/process-control';
import type { EquipmentStatusSnapshot } from '../../src/realtime/equipment-status';
import { resetTwinUiStore, twinUiActions } from '../../src/features/twin/state/twinUiStore';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '../../src/features/twin/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore } from '../../src/features/twin/state/twinDemoStore';

const backend = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../../src/rendering/lite-backend', () => ({
  createLiteBackend: () => ({
    async mount(_canvas: unknown, _fabs: unknown, _signal: unknown, status: (value: string) => void) {
      backend.mounts += 1;
      status('WebGPU · ready');
    },
    dispose() {},
  }),
}));

const sites = [{
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'test',
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
    { fabId: 'fab-b', code: 'FAB-B' },
    { fabId: 'fab-c', code: 'FAB-C' },
  ],
}];

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
  update: Partial<EquipmentStatusSnapshot> & { siteId?: string; fabId?: string },
): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId: 'fab-a',
  generatedAt: '2026-10-27T00:00:00Z',
  sequence: 1,
  epoch: 1,
  tools: tools(),
  ...update,
});

function setup(): QueryClient {
  CapturingEventSource.instances = [];
  backend.mounts = 0;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, sites);
  return client;
}

function renderTwin(client: QueryClient, fabId: string) {
  return render(
    <QueryClientProvider client={client}>
      <TwinPage fabId={fabId} search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );
}

async function streamFor(fabId: string): Promise<CapturingEventSource> {
  const url = `/api/v1/sites/site-1/fabs/${fabId}/equipment-status/stream`;
  await waitFor(() => expect(CapturingEventSource.instances.some((source) => source.url === url)).toBe(true));
  const source = CapturingEventSource.instances.find((value) => value.url === url);
  if (!source) throw new Error('missing equipment-status stream for ' + fabId);
  return source;
}

const send = (source: CapturingEventSource, value: unknown) => {
  act(() => { source.onmessage?.({ data: JSON.stringify(value) }); });
};

/** The projection publishes through the 100 ms coalesced batcher by design. */
const flushProjection = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)); });

afterEach(() => {
  cleanup();
  backend.mounts = 0;
  CapturingEventSource.instances = [];
  vi.unstubAllGlobals();
  resetTwinUiStore(); resetTwinPageStore(); resetRuntimeStore(); resetTwinDemoStore();
});

it('scopes telemetry/status REST + SSE to the canonical route FAB of a multi-FAB site', async () => {
  const fetchUrls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return new Promise(() => {});
  }));
  const streamUrls: string[] = [];
  vi.stubGlobal('EventSource', class {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) { streamUrls.push(url); }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, sites);

  render(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-b" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  // A 3-FAB site renders instead of the removed single-FAB product gate.
  await waitFor(() => expect(backend.mounts).toBe(1));
  expect(document.body.textContent).not.toContain('当前产品必须只有一个 FAB');
  await waitFor(() => expect(streamUrls).toContain('/api/v1/sites/site-1/fabs/fab-b/equipment-status/stream'));
  await waitFor(() => expect(fetchUrls).toContain('/api/v1/sites/site-1/fabs/fab-b/equipment-status'));
  expect(fetchUrls.some((url) => url.includes('/fabs/fab-a/'))).toBe(false);
  expect(fetchUrls.some((url) => url.includes('/fabs/fab-c/'))).toBe(false);
  expect(document.title).toBe('SITE-1 / FAB-B · 3D FAB');
  client.clear();
});

it('A01: an in-place A→B switch clears FAB-scoped projections before B has a frame', async () => {
  const client = setup();
  const view = renderTwin(client, 'fab-a');
  const sourceA = await streamFor('fab-a');
  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-a'));

  // Seed MES demo state owned by A; it must not survive into B.
  act(() => {
    twinPageActions.mesJobSet({ index: 3, job: createMesJob(FAB_LAYOUT[3], 3) });
    twinPageActions.inspectorMesSet({ id: 'ref-tool', job: createMesJob(FAB_LAYOUT[4], 4) });
  });

  send(sourceA, frame({ sequence: 5, generatedAt: '2026-10-27T00:00:05Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down'));
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:05Z', stale: false });

  // Queue a newer A frame in the 100 ms batcher and switch FABs before it can
  // publish: the pending batch must be cancelled, not flushed into B.
  send(sourceA, frame({ sequence: 6, generatedAt: '2026-10-27T00:00:06Z', tools: tools({ 0: 'maint', 1: 'idle' }) }));
  view.rerender(
    <QueryClientProvider client={client}>
      <TwinPage fabId="fab-b" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-b'));
  // B renders only its own reset projections, never A's last frame or MES jobs.
  expect(useTwinPageStore.getState().liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(useTwinPageStore.getState().statusFeed).toBeUndefined();
  expect(useTwinPageStore.getState().mesJobs).toEqual({});
  expect(useTwinPageStore.getState().inspectorMes).toEqual({});
  await flushProjection();
  expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-b');
  expect(useTwinPageStore.getState().liveToolStates).toEqual([...FAB_TOOL_STATES]);

  // B's first accepted frame may use a lower sequence than A: ordering state is
  // per FAB, so the site never shares one high-water mark across FABs.
  const sourceB = await streamFor('fab-b');
  send(sourceB, frame({ fabId: 'fab-b', sequence: 1, generatedAt: '2026-10-27T00:00:20Z', tools: tools({ 0: 'idle' }) }));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('idle'));
  expect(useTwinPageStore.getState().liveStatusScope).toEqual({ siteId: 'site-1', fabId: 'fab-b' });
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:20Z', stale: false });
  client.clear();
});

it('A02: an SSE frame rejected by the ordered consumer never reaches the FAB-scoped Query cache', async () => {
  const client = setup();
  renderTwin(client, 'fab-a');
  const source = await streamFor('fab-a');
  const key = equipmentStatusQueryKey('site-1', 'fab-a');

  send(source, frame({ sequence: 2, generatedAt: '2026-10-27T00:00:02Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(client.getQueryData<EquipmentStatusSnapshot>(key)?.sequence).toBe(2));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down'));

  // Older frame: the ordered consumer rejects it, so the shared cache keeps the
  // newer accepted snapshot (the audited behaviour wrote it unconditionally).
  send(source, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:01Z', tools: tools({ 0: 'maint' }) }));
  await flushProjection();
  const cached = client.getQueryData<EquipmentStatusSnapshot>(key);
  expect(cached?.sequence).toBe(2);
  expect(cached?.tools[0].state).toBe('down');
  expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down');
  client.clear();
});
it('A01: a disconnected status stream is labelled CACHE, never LIVE', async () => {
  const client = setup();
  renderTwin(client, 'fab-a');
  act(() => twinUiActions.sourceSet('sse-live'));
  const source = await streamFor('fab-a');
  const feed = () => document.querySelector('.twin-feed')?.textContent ?? '';

  send(source, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:01Z' }));
  await waitFor(() => expect(useTwinPageStore.getState().statusFeed?.stale).toBe(false));
  expect(feed()).toContain('LIVE');
  act(() => { source.onerror?.({}); });
  expect(useTwinPageStore.getState().statusFeed?.stale).toBe(true);
  expect(feed()).toContain('CACHE');
  expect(feed()).not.toContain('LIVE');
  client.clear();
});
