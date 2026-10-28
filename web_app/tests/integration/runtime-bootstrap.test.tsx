// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/app/providers/AppProviders';
import { useCommandProjection, useFabRuntimeRegistry } from '../../src/app/providers/RuntimeProvider';
import { useFabTelemetry } from '../../src/app/providers/TelemetryProvider';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import WorkbenchApp from '../../src/features/workbench/workbench';
import type { FabRuntimeRegistry } from '../../src/runtime/FabRuntimeRegistry';

const sites = [{
  siteId: 'site-1',
  code: 'SITE-1',
  templateHash: 'h'.repeat(64),
  fabs: [
    { fabId: 'fab-a', code: 'FAB-A' },
    { fabId: 'fab-b', code: 'FAB-B' },
    { fabId: 'fab-c', code: 'FAB-C' },
  ],
}];

let captured: FabRuntimeRegistry | null = null;

function RegistryProbe() {
  const registry = useFabRuntimeRegistry();
  captured = registry;
  return <div data-testid="runtime-fabs">{registry?.size ?? -1}</div>;
}

function clientWithSites(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sitesQueryOptions().queryKey, sites);
  return client;
}

afterEach(() => {
  cleanup();
  captured = null;
  vi.unstubAllGlobals();
});

it('assembles one XState runtime per FAB from the sites document', async () => {
  render(<AppProviders client={clientWithSites()}><RegistryProbe /></AppProviders>);
  // Registry mutations do not re-render the probe; poll the captured registry.
  await waitFor(() => expect(captured?.size).toBe(3));
  expect(captured?.fabIds).toEqual(['fab-a', 'fab-b', 'fab-c']);
  expect(captured?.get('fab-a')?.running).toBe(true);
  expect(captured?.get('fab-a')?.getProjection('missing')).toBeUndefined();
});

it('disposes runtimes when the provider unmounts (StrictMode-safe lifecycle)', async () => {
  const { unmount } = render(<AppProviders client={clientWithSites()}><RegistryProbe /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(3));
  const registry = captured;
  unmount();
  await waitFor(() => expect(registry?.size).toBe(0));
});

function TelemetryProbe() {
  const middle = useFabTelemetry('fab-b');
  const missing = useFabTelemetry('missing');
  return <div data-testid="fab-telemetry">{middle ? middle.fabId : 'none'}:{missing ? 'leak' : 'none'}</div>;
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

  const view = render(<AppProviders client={clientWithSites()}><RegistryProbe /><TelemetryProbe /></AppProviders>);
  // Telemetry is demand-driven: only fab-b has a mounted consumer, so only its
  // FAB-scoped stream is opened (idle FABs must not consume connections).
  await waitFor(() => expect(telemetryUrls.length).toBe(1));
  expect(telemetryUrls).toEqual([
    '/api/v1/sites/site-1/fabs/fab-b/telemetry/stream',
  ]);
  // Command streams are lazy: no per-FAB SSE connection is opened until the
  // first command is tracked. Then the stream is FAB-scoped + authorized.
  expect(commandUrls).toEqual([]);
  captured?.get('fab-a')?.trackCommand('cmd-a');
  await waitFor(() => expect([...commandUrls].sort()).toEqual([
    '/api/v1/sites/site-1/commands/stream?fabId=fab-a',
  ]));
  expect(commandUrls.some((url) => !url.includes('?fabId='))).toBe(false);
  await waitFor(() => expect(screen.getByTestId('fab-telemetry').textContent).toBe('fab-b:none'));
  expect(captured?.size).toBe(3);

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

  const client = clientWithSites();
  const view = render(
    <AppProviders client={client}>
      <TelemetryConsumer fabId="fab-b" testId="consumer-a" />
      <TelemetryConsumer fabId="fab-b" testId="consumer-b" />
    </AppProviders>,
  );
  await waitFor(() => expect(telemetryUrls.length).toBe(1));
  await waitFor(() => expect(screen.getByTestId('consumer-a').textContent).toBe('fab-b'));
  expect(screen.getByTestId('consumer-b').textContent).toBe('fab-b');
  expect(closed).toEqual([]);

  // Unmounting one of two consumers keeps the shared runtime and stream open.
  view.rerender(
    <AppProviders client={client}>
      <TelemetryConsumer fabId="fab-b" testId="consumer-a" />
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

it('delivers each FAB command SSE stream to its own FabRuntime only', async () => {
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
    <AppProviders client={clientWithSites()}>
      <RegistryProbe />
      <ProjectionProbe fabId="fab-b" commandId="cmd-1" />
    </AppProviders>,
  );
  await waitFor(() => expect(captured?.size).toBe(3));
  // Lazy streams: only tracked FABs open a command SSE connection.
  captured?.get('fab-b')?.trackCommand('cmd-1');
  captured?.get('fab-a')?.trackCommand('cmd-a');
  await waitFor(() => expect(sources.size).toBe(2));

  const emit = (fabId: string, event: unknown) => {
    sources.get(`/api/v1/sites/site-1/commands/stream?fabId=${fabId}`)?.onmessage?.({ data: JSON.stringify(event) });
  };
  const envelope = (fabId: string) => ({
    topic: 'command.result', sequence: 1,
    payload: { fabId, commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z' },
  });

  // An event on another FAB's stream never reaches this runtime.
  emit('fab-a', envelope('fab-a'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('idle:-1');

  emit('fab-b', envelope('fab-b'));
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
  const view = render(<AppProviders client={clientWithSites()}><RegistryProbe /><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(captured?.size).toBe(3));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(urls).toEqual([]);
  view.unmount();
});

it('shows a data-driven FAB selector in the workbench when the site has multiple FABs', async () => {
  const client = clientWithSites();
  render(<AppProviders client={client}><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(screen.getByText('XSTATE RUNTIMES')).toBeTruthy());
  const selector = document.querySelector('aside select');
  expect(selector).not.toBeNull();
  expect(selector?.querySelectorAll('option')).toHaveLength(3);
});
