// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FabViewport } from '../../src/features/twin/fab-viewer';
import { TwinPage } from '../../src/features/twin/twin-page';
import { TelemetryProvider } from '../../src/app/providers/TelemetryProvider';
import { FabTelemetryRegistry } from '../../src/realtime/telemetry/FabTelemetryRegistry';
import { TelemetryRuntime } from '../../src/realtime/telemetry/TelemetryRuntime';
import { createTelemetryWorkerHandler } from '../../src/realtime/workers/telemetryWorker.logic';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { resetTwinUiStore } from '../../src/state/twinUiStore';
import { resetTwinPageStore } from '../../src/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore, twinDemoActions, useTwinDemoStore } from '../../src/state/twinDemoStore';
import { twinUiActions } from '../../src/state/twinUiStore';
import type { FabToolState } from '../../src/fab-layout';

const backend = vi.hoisted(() => ({ getters: [] as Array<() => readonly FabToolState[]> }));
vi.mock('../../src/lite-backend', () => ({ createLiteBackend: () => ({
  async mount(_canvas: unknown, _fabs: unknown, _signal: unknown, status: (value: string) => void, _pick: unknown, _stats: unknown, _hover: unknown, getter: () => readonly FabToolState[]) {
    backend.getters.push(getter); status('WebGPU · ready');
  },
  dispose() {},
}) }));
const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
afterEach(() => { cleanup(); backend.getters.length = 0; vi.unstubAllGlobals(); resetTwinUiStore(); resetTwinPageStore(); resetTwinDemoStore(); resetRuntimeStore(); });

it('uses a changed frame source without remounting the scene', async () => {
  const props = { site, fab: site.fabs[0], toolStates: ['running'] as FabToolState[], layers: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false }, explodeFactor: 0, basement: false, dual: false };
  const view = render(<FabViewport {...props} getToolStates={() => ['running']} />);
  await waitFor(() => expect(backend.getters.length).toBe(1));
  view.rerender(<FabViewport {...props} getToolStates={() => ['down']} />);
  expect(backend.getters[0]()).toEqual(['down']);
  expect(backend.getters).toHaveLength(1);
});

it('keeps paused DEMO states isolated while consuming telemetry in live mode', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const source = { onmessage: null as ((event: { data: string }) => void) | null, onopen: null as (() => void) | null, close() {} };
  const worker = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage(message: unknown) { const result = handler.handle(message); if (result) this.onmessage?.({ data: result }); }, terminate() {} };
  const telemetry = new TelemetryRuntime({ url: 'fake', fabId: 'fab-1', eventSourceFactory: () => source, workerFactory: () => worker });
  telemetry.start(); source.onopen?.();
  source.onmessage?.({ data: JSON.stringify({ topic: 'telemetry.frame', sequence: 1, payload: { fabId: 'fab-1', sequence: 1, capturedAt: 'now', samples: [{ entityId: 'equipment-0', values: { state: 2, utilization: 0.5 } }] } }) });
  const registry = new FabTelemetryRegistry(); registry.replaceAll(new Map([['fab-1', telemetry]]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
  twinDemoActions.playingSet(false);
  const view = render(<QueryClientProvider client={client}><TelemetryProvider registry={registry}><TwinPage fabId="fab-1" search={{ modal: 'arch' }} /></TelemetryProvider></QueryClientProvider>);
  await waitFor(() => expect(backend.getters.length).toBe(1));
  expect(backend.getters[0]()).toEqual(useTwinDemoStore.getState().states);
  twinUiActions.sourceSet('sse-live');
  expect(backend.getters[0]()[0]).toBe('down');
  twinUiActions.sourceSet('demo');
  expect(backend.getters[0]()).toEqual(useTwinDemoStore.getState().states);
  view.unmount(); client.clear(); registry.disposeAll();
});
