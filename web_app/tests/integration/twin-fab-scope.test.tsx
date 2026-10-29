// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestRuntime, readEquipmentStatus, seedSites, ResourceTestProviders, type AppRuntime } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import { createMesJob } from '@/domain/fab-process-control';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { twinPageActions, twinPageAtom } from '@/twin/twin-page.atom';



const backend = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../../tests/support/scene-port-stub');
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

function setup(): AppRuntime<never> {
  CapturingEventSource.instances = [];
  backend.mounts = 0;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = createTestRuntime(registry);
  seedSites(client, sites);
  return client;
}

function renderTwin(client: AppRuntime<never>, fabId: string) {
  return render(
    <ResourceTestProviders runtime={client}>
      <TwinPage fabId={fabId} search={{ modal: 'arch' }} />
    </ResourceTestProviders>,
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
  resetTwinUiState(registry); resetTwinPageState(registry); resetRuntimeState(registry); resetTwinDemoState(registry);
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
  const client = createTestRuntime(registry);
  seedSites(client, sites);

  render(
    <ResourceTestProviders runtime={client}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </ResourceTestProviders>,
  );

  await waitFor(() => expect(backend.mounts).toBe(1));
  await waitFor(() => expect(streamUrls).toEqual(['/api/v1/sites/site-1/fabs/fab-a/equipment-status/stream']));
  await waitFor(() => expect(fetchUrls).toContain('/api/v1/sites/site-1/fabs/fab-a/equipment-status'));
  expect(fetchUrls.filter((url) => url.includes('/fabs/')).every((url) => url.includes('/fabs/fab-a/'))).toBe(true);
  expect(document.title).toBe('SITE-1 / FAB-A · 3D FAB');
});

it('A01: provider replacement starts a fresh runtime baseline; the old generation can never write into it', async () => {
  const client = setup();
  const view = renderTwin(client, 'fab-a');
  const sourceA = await streamFor('fab-a');
  await waitFor(() => expect(registry.get(twinPageAtom).liveStatusScope?.fabId).toBe('fab-a'));

  // Seed state owned by the previous provider lifetime.
  act(() => {
    twinPageActions.mesJobSet(registry, { index: 3, job: createMesJob(FAB_LAYOUT[3], 3, 1000) });
    twinPageActions.inspectorMesSet(registry, { id: 'ref-tool', job: createMesJob(FAB_LAYOUT[4], 4, 1000) });
  });

  send(sourceA, frame({ sequence: 5, generatedAt: '2026-10-27T00:00:05Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down'));
  expect(registry.get(twinPageAtom).statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:05Z', stale: false });
  // The old runtime accepted the frame in its own manager-owned Atom.
  expect(readEquipmentStatus(client, 'site-1', 'fab-a')?.sequence).toBe(5);

  // Queue a frame in the 100 ms batcher, then replace the provider before it can
  // publish. ADR-006 §2.1: each AppRuntime owns its manager/Atom, so the new
  // runtime is a new lifetime (ADR-007 §3 / CORE-009): no old state may enter it.
  send(sourceA, frame({ sequence: 6, generatedAt: '2026-10-27T00:00:06Z', tools: tools({ 0: 'maint', 1: 'idle' }) }));
  const previousGeneration = sourceA.onmessage;
  expect(readEquipmentStatus(client, 'site-1', 'fab-a')?.sequence, 'the old runtime owns its accepted snapshot').toBe(6);
  const replacementClient = createTestRuntime(registry);
  seedSites(replacementClient, sites);
  view.rerender(
    <ResourceTestProviders key="replacement" runtime={replacementClient}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </ResourceTestProviders>,
  );

  await waitFor(() => expect(sourceA.onmessage).toBeNull());
  // The same FAB starts its new runtime lifetime without old UI projections or Atom values.
  expect(registry.get(twinPageAtom).liveToolStates).toEqual([...FAB_TOOL_STATES]);
  expect(registry.get(twinPageAtom).statusFeed).toBeUndefined();
  expect(registry.get(twinPageAtom).mesJobs).toEqual({});
  expect(registry.get(twinPageAtom).inspectorMes).toEqual({});
  expect(readEquipmentStatus(replacementClient, 'site-1', 'fab-a'), 'new runtime starts from its own empty Atom').toBeUndefined();
  await flushProjection();
  expect(registry.get(twinPageAtom).liveStatusScope?.fabId).toBe('fab-a');
  expect(registry.get(twinPageAtom).liveToolStates).toEqual([...FAB_TOOL_STATES]);

  // A late callback captured from the previous generation is detached and writes nothing.
  act(() => { previousGeneration?.({ data: JSON.stringify(frame({ sequence: 99, generatedAt: '2026-10-27T00:00:09Z', tools: tools({ 0: 'down' }) })) }); });
  await flushProjection();
  expect(readEquipmentStatus(replacementClient, 'site-1', 'fab-a')).toBeUndefined();
  expect(registry.get(twinPageAtom).liveToolStates).toEqual([...FAB_TOOL_STATES]);

  // The new connection's first frame is the new runtime's own baseline (no cross-runtime high-water).
  const sourceNew = await streamFor('fab-a', 2);
  send(sourceNew, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:20Z', tools: tools({ 0: 'idle' }) }));
  await flushProjection();
  expect(readEquipmentStatus(replacementClient, 'site-1', 'fab-a')?.sequence).toBe(1);
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('idle');

  // Within the new runtime the ordered acceptance still applies: older/duplicate frames are ignored.
  send(sourceNew, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:21Z', tools: tools({ 0: 'maint' }) }));
  send(sourceNew, frame({ sequence: 2, generatedAt: '2026-10-27T00:00:22Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down'));
  expect(readEquipmentStatus(replacementClient, 'site-1', 'fab-a')?.sequence).toBe(2);
  expect(registry.get(twinPageAtom).liveStatusScope).toEqual({ siteId: 'site-1', fabId: 'fab-a' });
  expect(registry.get(twinPageAtom).statusFeed).toEqual({ updatedAt: '2026-10-27T00:00:22Z', stale: false });
});

it('A02: an SSE frame rejected by the ordered consumer never reaches the FAB-scoped resource Atom', async () => {
  const client = setup();
  renderTwin(client, 'fab-a');
  const source = await streamFor('fab-a');
  send(source, frame({ sequence: 2, generatedAt: '2026-10-27T00:00:02Z', tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(readEquipmentStatus(client, 'site-1', 'fab-a')?.sequence).toBe(2));
  await waitFor(() => expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down'));

  // Older frame: the ordered consumer rejects it, so the shared cache keeps the
  // newer accepted snapshot (the audited behaviour wrote it unconditionally).
  send(source, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:01Z', tools: tools({ 0: 'maint' }) }));
  await flushProjection();
  const cached = readEquipmentStatus(client, 'site-1', 'fab-a');
  expect(cached?.sequence).toBe(2);
  expect(cached?.tools[0].state).toBe('down');
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down');
});
it('A01: a disconnected status stream is labelled CACHE, never LIVE', async () => {
  const client = setup();
  renderTwin(client, 'fab-a');
  act(() => twinUiActions.sourceSet(registry, 'sse-live'));
  const source = await streamFor('fab-a');
  const feed = () => document.querySelector('.twin-feed')?.textContent ?? '';

  send(source, frame({ sequence: 1, generatedAt: '2026-10-27T00:00:01Z' }));
  await waitFor(() => expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(false));
  expect(feed()).toContain('LIVE');
  act(() => { source.onerror?.({}); });
  expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(true);
  expect(feed()).toContain('CACHE');
  expect(feed()).not.toContain('LIVE');
});