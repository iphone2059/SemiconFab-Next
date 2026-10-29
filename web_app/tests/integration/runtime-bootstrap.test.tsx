// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/app-providers';
import { useCommandProjection, useFabRuntimeRegistry } from '@/app/runtime-provider';
import { useFabTelemetry } from '@/app/telemetry-provider';
import { createRuntimeWithSites, type AppRuntime } from '../support/resource-test-runtime.tsx';
import WorkbenchApp from '@/workbench/workbench';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';

const sites = [{
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'h'.repeat(64),
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
  ],
}];

let captured: FabRuntimeRegistry | null = null;

function RegistryProbe() {
  const registry = useFabRuntimeRegistry();
  captured = registry;
  return <div data-testid="runtime-fabs">{registry?.size ?? -1}</div>;
}

const runtimes: AppRuntime<never>[] = [];
function runtimeWithSites(): AppRuntime<never> {
  const runtime = createRuntimeWithSites(sites);
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  captured = null;
  vi.unstubAllGlobals();
});

it('assembles the configured FAB XState runtime from the sites document', async () => {
  render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  // Registry mutations do not re-render the probe; poll the captured registry.
  await waitFor(() => expect(captured?.size).toBe(1));
  expect(captured?.fabIds).toEqual(['fab-a']);
  expect(captured?.get('unknown-fab')).toBeUndefined();
  expect(captured?.get('fab-a')?.running).toBe(true);
  expect(captured?.get('fab-a')?.getProjection('missing')).toBeUndefined();
});

it('disposes runtimes when the provider unmounts (StrictMode-safe lifecycle)', async () => {
  const { unmount } = render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  const registry = captured;
  unmount();
  await waitFor(() => expect(registry?.size).toBe(0));
});

function TelemetryProbe() {
  const active = useFabTelemetry('fab-a');
  const missing = useFabTelemetry('missing');
  return <div data-testid="fab-telemetry">{active ? active.fabId : 'none'}:{missing ? 'leak' : 'none'}</div>;
}

it('starts only the consumed FAB telemetry runtime and exposes useFabTelemetry(fabId)', async () => {
  const telemetryUrls: string[] = [];
  const commandUrls: string[] = [];
  const closed: string[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) {
      if (url.includes('/telemetry/stream')) telemetryUrls.push(url);
      else commandUrls.push(url);
    }
    addEventListener() {}
    removeEventListener() {}
    close() { closed.push(this.url); }
  }
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('Worker', FakeWorker);

  const view = render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /><TelemetryProbe /></AppProviders>);
  // Telemetry is demand-driven: the configured FAB has one mounted consumer.
  await waitFor(() => expect(telemetryUrls.length).toBe(1));
  expect(telemetryUrls).toEqual([
    '/api/v1/sites/site-1/fabs/fab-a/telemetry/stream',
  ]);
  // Command streams are lazy: no per-FAB SSE connection is opened until the
  // first command is tracked. Then the stream is FAB-scoped + authorized.
  expect(commandUrls).toEqual([]);
  captured?.get('fab-a')?.trackCommand('cmd-a');
  await waitFor(() => expect([...commandUrls].sort()).toEqual([
    '/api/v1/sites/site-1/commands/stream?fabId=fab-a',
  ]));
  expect(commandUrls.some((url) => !url.includes('?fabId='))).toBe(false);
  await waitFor(() => expect(screen.getByTestId('fab-telemetry').textContent).toBe('fab-a:none'));
  expect(captured?.size).toBe(1);

  view.unmount();
  const allUrls = [...telemetryUrls, ...commandUrls];
  await waitFor(() => expect(allUrls.every((url) => closed.includes(url))).toBe(true));
});

function TelemetryConsumer({ fabId, testId }: { fabId: string; testId: string }) {
  const runtime = useFabTelemetry(fabId);
  return <div data-testid={testId}>{runtime ? runtime.fabId : 'none'}</div>;
}

it('keeps one FAB telemetry stream alive until the last useFabTelemetry consumer unmounts', async () => {
  const telemetryUrls: string[] = [];
  const closed: string[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) {
      if (url.includes('/telemetry/stream')) telemetryUrls.push(url);
    }
    addEventListener() {}
    removeEventListener() {}
    close() { closed.push(this.url); }
  }
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('Worker', FakeWorker);

  const client = runtimeWithSites();
  const view = render(
    <AppProviders runtime={client}>
      <TelemetryConsumer fabId="fab-a" testId="consumer-a" />
      <TelemetryConsumer fabId="fab-a" testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect(telemetryUrls.length).toBe(1));
  await waitFor(() => expect(screen.getByTestId('consumer-a').textContent).toBe('fab-a'));
  expect(screen.getByTestId('consumer-b').textContent).toBe('fab-a');
  expect(closed).toEqual([]);

  // Unmounting one of two consumers keeps the shared runtime and stream open.
  view.rerender(
    <AppProviders runtime={client}>
      <TelemetryConsumer fabId="fab-a" testId="consumer-a" />
    </AppProviders>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toEqual([]);
  expect(telemetryUrls).toHaveLength(1);

  // The last consumer unmounts: the runtime stops and its stream closes.
  view.unmount();
  await waitFor(() => expect(closed).toEqual([telemetryUrls[0]]));
});

function ProjectionProbe({ fabId, commandId }: { fabId: string; commandId: string }) {
  const projection = useCommandProjection(fabId, commandId);
  return <div data-testid="projection">{projection ? `${projection.state}:${projection.revision}` : 'none'}</div>;
}

it('rejects a foreign FAB payload on the configured command SSE stream', async () => {
  const sources = new Map<string, { onmessage: ((event: { data: string }) => void) | null }>();
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) { sources.set(url, this); }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);

  render(
    <AppProviders runtime={runtimeWithSites()}>
      <RegistryProbe />
      <ProjectionProbe fabId="fab-a" commandId="cmd-1" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(1));
  // Tracking the command opens only the configured FAB's lazy stream.
  captured?.get('fab-a')?.trackCommand('cmd-1');
  await waitFor(() => expect(sources.size).toBe(1));

  const emit = (fabId: string, event: unknown) => {
    sources.get(`/api/v1/sites/site-1/commands/stream?fabId=${fabId}`)?.onmessage?.({ data: JSON.stringify(event) });
  };
  const envelope = (fabId: string, sequence: number) => ({
    topic: 'command.result', sequence,
    payload: { fabId, commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z' },
  });

  // A malformed foreign payload is rejected without configuring another FAB.
  emit('fab-a', envelope('unknown-fab', 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('idle:-1');

  emit('fab-a', envelope('fab-a', 2));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));
});

it('does not hold idle FAB telemetry/command SSE connections on the workbench route', async () => {
  const urls: string[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string) { urls.push(url); }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('Worker', FakeWorker);
  const view = render(<AppProviders runtime={runtimeWithSites()}><RegistryProbe /><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(urls).toEqual([]);
  view.unmount();
});

it('shows the configured FAB in the workbench without a redundant FAB selector', async () => {
  const client = runtimeWithSites();
  render(<AppProviders runtime={client}><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(screen.getByText('XSTATE RUNTIMES')).toBeTruthy());
  const selector = document.querySelector('aside select');
  expect(selector).toBeNull();
  expect(screen.getByText('FAB-A')).toBeTruthy();
  expect(document.querySelectorAll('.fab-card')).toHaveLength(1);
});
