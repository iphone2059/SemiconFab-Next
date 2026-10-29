// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog.ts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { sitesQueryOptions } from '@/api/sites.resource';
import { equipmentStatusQueryKey } from '@/api/equipment.resource';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import { createMesJob } from '@/domain/fab-process-control';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { resetTwinUiStore, twinUiActions } from '@/twin/twin-ui.atom';
import { resetTwinPageStore, twinPageActions, useTwinPageStore } from '@/twin/twin-page.atom';
import { resetRuntimeStore } from '@/state/runtime-store';
import { resetTwinDemoStore } from '@/twin/twin-demo.atom';

const backend = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../support/scene-port-stub.ts');
  return {
    createLiteBackend: () => {
      backend.mounts += 1;
      return createScenePortStub();
    },
  };
});

const sites = [{
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'test',
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
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

async function streamFor(fabId: string, expectedCount = 1): Promise<CapturingEventSource> {
  const url = `/api/v1/sites/site-1/fabs/${fabId}/equipment-status/stream`;
  await waitFor(() => expect(CapturingEventSource.instances.filter((source) => source.url === url)).toHaveLength(expectedCount));
  const source = CapturingEventSource.instances.filter((value) => value.url === url)[expectedCount - 1];
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

it('scopes status REST + SSE to the single configured canonical route FAB', async () => {
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
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(backend.mounts).toBe(1));
  await waitFor(() => expect(streamUrls).toEqual(['/api/v1/sites/site-1/fabs/fab-a/equipment-status/stream']));
  await waitFor(() => expect(fetchUrls).toContain('/api/v1/sites/site-1/fabs/fab-a/equipment-status'));
  expect(fetchUrls.filter((url) => url.includes('/fabs/')).every((url) => url.includes('/fabs/fab-a/'))).toBe(true);
  expect(document.title).toBe('SITE-1 / FAB-A · 3D FAB');
  client.clear();
});

it('A01: remounting the Query provider clears projections before the same FAB has a new frame', async () => {
  const client = setup();
  const view = renderTwin(client, 'fab-a');
  const sourceA = await streamFor('fab-a');
  await waitFor(() => expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-a'));

  // Seed state owned by the previous provider lifetime.
  act(() => {
    twinPageActions.mesJobSet({ index: 3, job: createMesJob(FAB_LAYOUT[3], 3, 1000) });
    twinPageActions.inspectorMesSet({ id: 'ref-tool', job: createMesJob(FAB_LAYOUT[4], 4, 1000) });
  });

  send(sourceA, frame({ sequence: 5, generatedAt: '2026-10-27T00:00:05Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('down'));
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:05Z', stale: false });

  // Queue a frame in the 100 ms batcher and remount its Query provider before it
  // can publish: pending work must not escape into the new lifetime.
  send(sourceA, frame({ sequence: 6, generatedAt: '2026-10-27T00:00:06Z', tools: tools({ 0: 'maint', 1: 'idle' }) }));
  const replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  replacementClient.setQueryData(sitesQueryOptions().queryKey, sites);
  view.rerender(
    <QueryClientProvider key="replacement" client={replacementClient}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(sourceA.onmessage).toBeNull());
  // The same FAB starts its new provider lifetime without old projections.
  expect(useTwinPageStore.getState().liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(useTwinPageStore.getState().statusFeed).toBeUndefined();
  expect(useTwinPageStore.getState().mesJobs).toEqual({});
  expect(useTwinPageStore.getState().inspectorMes).toEqual({});
  await flushProjection();
  expect(useTwinPageStore.getState().liveStatusScope?.fabId).toBe('fab-a');
  expect(useTwinPageStore.getState().liveToolStates).toEqual([...FAB_TOOL_STATES]);

  // A new provider has independent ordering history for the same FAB.
  const sourceNew = await streamFor('fab-a', 2);
  send(sourceNew, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:20Z', tools: tools({ 0: 'idle' }) }));
  await waitFor(() => expect(useTwinPageStore.getState().liveToolStates[0]).toBe('idle'));
  expect(useTwinPageStore.getState().liveStatusScope).toEqual({ siteId: 'site-1', fabId: 'fab-a' });
  expect(useTwinPageStore.getState().statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:20Z', stale: false });
  client.clear();
  replacementClient.clear();
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
