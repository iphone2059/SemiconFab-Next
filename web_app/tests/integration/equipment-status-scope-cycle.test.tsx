// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedSites, readEquipmentStatus, ResourceTestProviders, type AppRuntime } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { TwinPage } from '@/twin/twin-page';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '@/domain/fab-layout';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { twinPageAtom } from '@/twin/twin-page.atom';


import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';

/**
 * Same-FAB mount/unmount/remount cycle across the real TwinPage pipeline: the
 * Query cache, ordering gate, SSE subscriptions and page projection must resume
 * from the accepted cache/ordering high-water instead of regressing. Pins that the old
 * EventSource generation is detached (no stale-generation async callback can
 * publish into the remounted page).
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
  ],
};

class CapturingEventSource {
  static instances: CapturingEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    CapturingEventSource.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
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
const cached = (client: AppRuntime<never>, fabId: string) =>
  readEquipmentStatus(client, 'site-1', fabId);

afterEach(() => {
  cleanup();
  viewport.renders = 0;
  CapturingEventSource.instances = [];
  vi.unstubAllGlobals();
  resetTwinUiState(registry); resetTwinPageState(registry); resetRuntimeState(registry); resetTwinDemoState(registry);
});

it('keeps Query cache and ordering across same-FAB remounts while detaching old SSE generations', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', CapturingEventSource);
  const client = createTestRuntime(registry);
  seedSites(client, [site]);
  const tree = (
    <ResourceTestProviders runtime={client}>
      <TwinPage fabId="fab-a" search={{ modal: 'arch' }} />
    </ResourceTestProviders>
  );
  const view = render(tree);

  const sourceA = await streamFor('fab-a', 1);
  await waitFor(() => expect(registry.get(twinPageAtom).liveStatusScope?.fabId).toBe('fab-a'));
  // Keep the demo clock out of the projection latency budget.
  act(() => twinUiActions.sourceSet(registry, 'sse-live'));
  send(sourceA, frame('fab-a', 5, '2026-10-27T00:00:05Z', { tools: tools({ 0: 'down' }) }));
  await waitFor(() => expect(cached(client, 'fab-a')?.sequence).toBe(5));
  await waitFor(() => expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down'));

  const lateFirstCallback = sourceA.onmessage;
  view.unmount();
  expect(sourceA.closed).toBe(true);
  const remounted = render(tree);
  const sourceA2 = await streamFor('fab-a', 2);
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  // Only one stream is active; even a callback captured before cleanup is guarded.
  expect(sourceA.onmessage).toBeNull();
  expect(CapturingEventSource.instances.filter((source) => !source.closed)).toHaveLength(1);
  act(() => lateFirstCallback?.({ data: JSON.stringify(frame('fab-a', 99, '2026-10-27T00:00:20Z')) }));
  expect(cached(client, 'fab-a')?.sequence).toBe(5);

  // Reconnect replay + older frame of the remounted FAB: dropped by the gate.
  send(sourceA2, frame('fab-a', 5, '2026-10-27T00:00:05Z', { tools: tools({ 0: 'maint' }) }));
  send(sourceA2, frame('fab-a', 4, '2026-10-27T00:00:04Z', { tools: tools({ 0: 'maint' }) }));
  await flushProjection();
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  expect(cached(client, 'fab-a')?.tools[0].state).toBe('down');
  expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('down');

  // A crossed-FAB frame on A's stream marks the feed stale but never writes the cache.
  send(sourceA2, frame('unknown-fab', 6, '2026-10-27T00:00:06Z', { tools: tools({ 0: 'maint' }) }));
  expect(cached(client, 'fab-a')?.sequence).toBe(5);
  expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(true);

  // A genuinely newer frame recovers LIVE and advances the single cache entry.
  send(sourceA2, frame('fab-a', 6, '2026-10-27T00:00:06Z', { tools: tools({ 0: 'maint' }) }));
  await waitFor(() => expect(cached(client, 'fab-a')?.sequence).toBe(6));
  await waitFor(() => expect(registry.get(twinPageAtom).liveToolStates[0]).toBe('maint'));
  expect(registry.get(twinPageAtom).statusFeed?.stale).toBe(false);
  expect(cached(client, 'unknown-fab')).toBeUndefined();
  // A's accepted layout is complete: the projection never fell back to defaults.
  expect(registry.get(twinPageAtom).liveToolStates).toHaveLength(FAB_TOOL_STATES.length);
  remounted.unmount();
  expect(sourceA2.closed).toBe(true);
});
