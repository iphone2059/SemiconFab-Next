// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { FabViewport } from '../../src/features/twin/fab-viewer';
import { TwinPage } from '../../src/features/twin/twin-page';
import { TelemetryProvider } from '../../src/app/providers/TelemetryProvider';
import { FabTelemetryRegistry } from '../../src/realtime/telemetry/FabTelemetryRegistry';
import { TelemetryRuntime } from '../../src/realtime/telemetry/TelemetryRuntime';
import { createTelemetryWorkerHandler } from '../../src/realtime/workers/telemetryWorker.logic';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { resetTwinUiStore } from '../../src/features/twin/state/twinUiStore';
import { resetTwinPageStore } from '../../src/features/twin/state/twinPageStore';
import { resetRuntimeStore, runtimeActions, useRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore, twinDemoActions, useTwinDemoStore } from '../../src/features/twin/state/twinDemoStore';
import { twinUiActions } from '../../src/features/twin/state/twinUiStore';
import type { FabToolState } from '../../src/domain/fab/fab-layout';
import type { ScenePortStub } from '../support/scene-port-stub';

const backend = vi.hoisted(() => ({ instances: [] as ScenePortStub[] }));
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../support/scene-port-stub');
  return {
    createLiteBackend: () => {
      const stub = createScenePortStub();
      backend.instances.push(stub);
      return stub;
    },
  };
});
const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] };
const sceneViews = (): string[] => backend.instances.flatMap(instance => [...instance.views]);
const frameSource = (index = 0) => backend.instances[index].mounts[0].callbacks.getToolStates;
afterEach(() => { cleanup(); backend.instances.length = 0; vi.unstubAllGlobals(); resetTwinUiStore(); resetTwinPageStore(); resetTwinDemoStore(); resetRuntimeStore(); });

it('does not reapply a preset on GPU recovery but applies it on viewport reload and view change', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sitesQueryOptions().queryKey, [site]);
  twinDemoActions.playingSet(false);
  const view = render(<QueryClientProvider client={client}><TwinPage fabId="fab-1" /></QueryClientProvider>);
  try {
    await waitFor(() => expect(sceneViews()).toHaveLength(1));
    const epoch = useRuntimeStore.getState().viewer.epoch!;
    act(() => runtimeActions.viewerLifecycleReceived({ epoch, event: { type: 'recovering', message: 'GPU 设备已丢失', cause: 'device-lost' } }));
    act(() => runtimeActions.viewerLifecycleReceived({ epoch, event: { type: 'ready', message: 'WebGPU · ready' } }));
    expect(sceneViews()).toHaveLength(1);
    act(() => runtimeActions.viewerReloadRequested());
    await waitFor(() => expect(backend.instances).toHaveLength(2));
    await waitFor(() => expect(sceneViews()).toHaveLength(2));
    act(() => twinUiActions.viewSet('top'));
    expect(sceneViews()).toEqual(['iso', 'iso', 'top']);
  } finally { view.unmount(); client.clear(); }
});

it('uses a changed frame source without remounting the scene', async () => {
  const props = { site, fab: site.fabs[0], toolStates: ['running'] as FabToolState[], layers: { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false }, explodeFactor: 0, basement: false, dual: false };
  const view = render(<FabViewport {...props} getToolStates={() => ['running']} />);
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const source = frameSource();
  expect(source()).toEqual(['running']);
  view.rerender(<FabViewport {...props} getToolStates={() => ['down']} />);
  expect(source()).toEqual(['down']);
  expect(backend.instances).toHaveLength(1);
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
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const toolStateSource = frameSource();
  expect(toolStateSource()).toEqual(useTwinDemoStore.getState().states);
  twinUiActions.sourceSet('sse-live');
  expect(toolStateSource()[0]).toBe('down');
  twinUiActions.sourceSet('demo');
  expect(toolStateSource()).toEqual(useTwinDemoStore.getState().states);
  view.unmount(); client.clear(); registry.disposeAll();
});
