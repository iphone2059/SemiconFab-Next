// @vitest-environment jsdom
import { resetRuntimeState, resetTwinDemoState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedSites, seedEquipmentStatus, ResourceTestProviders } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { FabViewport } from '@/twin/twin-viewer';
import { TwinPage } from '@/twin/twin-page';
import { TelemetryProvider } from '@/app/telemetry-provider';
import { FabTelemetryRegistry } from '@/realtime/telemetry-registry';
import { TelemetryRuntime } from '@/realtime/telemetry-runtime';
import { createTelemetryWorkerHandler } from '@/realtime/telemetry-worker.logic';


import { viewerActions, viewerSessionAtom } from '@/state/viewer.atom';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import { twinUiActions } from '@/twin/twin-ui.atom';
import { FAB_LAYOUT, type FabToolState } from '@/domain/fab-layout';
import { twinPageAtom } from '@/twin/twin-page.atom';
import type { ScenePortStub } from '../../tests/support/scene-port-stub';

const backend = vi.hoisted(() => ({ instances: [] as ScenePortStub[] }));
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../../tests/support/scene-port-stub');
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
afterEach(() => { cleanup(); backend.instances.length = 0; vi.unstubAllGlobals(); resetTwinUiState(registry); resetTwinPageState(registry); resetTwinDemoState(registry); resetRuntimeState(registry); });

it('does not reapply a preset on GPU recovery but applies it on viewport reload and view change', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  const client = createTestRuntime(registry);
  seedSites(client, [site]);
  twinDemoActions.playingSet(registry, false);
  const view = render(<ResourceTestProviders runtime={client}><TwinPage siteId="site-1" fabId="fab-1" /></ResourceTestProviders>);
  try {
    await waitFor(() => expect(sceneViews()).toHaveLength(1));
    const epoch = registry.get(viewerSessionAtom).epoch!;
    act(() => viewerActions.viewerLifecycleReceived(registry, { epoch, event: { type: 'recovering', message: 'GPU 设备已丢失', cause: 'device-lost' } }));
    act(() => viewerActions.viewerLifecycleReceived(registry, { epoch, event: { type: 'ready', message: 'WebGPU · ready' } }));
    expect(sceneViews()).toHaveLength(1);
    act(() => viewerActions.viewerReloadRequested(registry));
    await waitFor(() => expect(backend.instances).toHaveLength(2));
    await waitFor(() => expect(sceneViews()).toHaveLength(2));
    act(() => twinUiActions.viewSet(registry, 'top'));
    expect(sceneViews()).toEqual(['iso', 'iso', 'top']);
  } finally { view.unmount(); }
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
  const telemetry = new TelemetryRuntime({ siteId: 'site-1', fabId: 'fab-1', url: 'fake', eventSourceFactory: () => source, workerFactory: () => worker });
  telemetry.start(); source.onopen?.();
  source.onmessage?.({ data: JSON.stringify({ topic: 'telemetry.frame', sequence: 1, payload: { fabId: 'fab-1', sequence: 1, capturedAt: 'now', samples: [{ entityId: 'equipment-0', values: { state: 2, utilization: 0.5 } }] } }) });
  const telemetryRegistry = new FabTelemetryRegistry(); telemetryRegistry.replaceAll([telemetry]);
  const client = createTestRuntime(registry);
  seedSites(client, [site]);
  twinDemoActions.playingSet(registry, false);
  const view = render(<ResourceTestProviders runtime={client}><TelemetryProvider registry={telemetryRegistry}><TwinPage siteId="site-1" fabId="fab-1" search={{ modal: 'arch' }} /></TelemetryProvider></ResourceTestProviders>);
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const toolStateSource = frameSource();
  expect(toolStateSource()).toEqual(registry.get(twinDemoAtom).states);
  twinUiActions.sourceSet(registry, 'sse-live');
  expect(toolStateSource()[0]).toBe('down');
  twinUiActions.sourceSet(registry, 'demo');
  expect(toolStateSource()).toEqual(registry.get(twinDemoAtom).states);
  view.unmount(); telemetryRegistry.disposeAll();
});

it('falls back to accepted equipment status when telemetry disconnects and waits for a valid frame to recover', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const source = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onopen: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close() {},
  };
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) { const result = handler.handle(message); if (result) this.onmessage?.({ data: result }); },
    terminate() {},
  };
  const telemetry = new TelemetryRuntime({ siteId: site.siteId, fabId: 'fab-1', url: 'fake', eventSourceFactory: () => source, workerFactory: () => worker });
  const telemetryRegistry = new FabTelemetryRegistry();
  telemetryRegistry.replaceAll([telemetry]);
  const client = createTestRuntime();
  const scopedRegistry = client.registry;
  seedSites(client, [site]);
  twinDemoActions.playingSet(scopedRegistry, false);
  const view = render(<ResourceTestProviders runtime={client}><TelemetryProvider registry={telemetryRegistry}><TwinPage siteId={site.siteId} fabId="fab-1" search={{ modal: 'arch' }} /></TelemetryProvider></ResourceTestProviders>);
  const send = (sequence: number, state: number) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence,
    payload: { fabId: 'fab-1', sequence, capturedAt: '2026-10-30T00:00:00Z', samples: [{ entityId: 'equipment-0', values: { state, utilization: 0.5 } }] },
  }) });
  try {
    await waitFor(() => expect(backend.instances).toHaveLength(1));
    await act(async () => {
      twinUiActions.sourceSet(scopedRegistry, 'sse-live');
      seedEquipmentStatus(client, site.siteId, 'fab-1', {
        siteId: site.siteId, fabId: 'fab-1', epoch: 1, sequence: 10,
        generatedAt: '2026-10-30T00:00:00Z', tools: FAB_LAYOUT.map(() => ({ state: 'down' })),
      });
    });
    await waitFor(() => expect(scopedRegistry.get(twinPageAtom).liveToolStates[0]).toBe('down'));
    const toolStateSource = frameSource();
    act(() => { source.onopen?.(); send(1, 0); });
    expect(toolStateSource()[0]).toBe('running');
    act(() => { source.onerror?.(); });
    expect(telemetry.stale).toBe(true);
    expect(toolStateSource()[0]).toBe('down');
    expect(scopedRegistry.get(twinPageAtom).statusFeed?.stale).toBe(false);
    act(() => { source.onopen?.(); });
    expect(toolStateSource()[0]).toBe('down');
    act(() => { send(1, 3); });
    expect(telemetry.status).toBe('live');
    expect(toolStateSource()[0]).toBe('maint');
  } finally {
    view.unmount();
    telemetryRegistry.disposeAll();
    await client.dispose();
  }
});
