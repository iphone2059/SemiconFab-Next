// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/app/providers/AppProviders';
import { useFabRuntimeRegistry } from '../../src/app/providers/RuntimeProvider';
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

it('starts one FAB-scoped telemetry runtime per FAB and exposes useFabTelemetry(fabId)', async () => {
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
  await waitFor(() => expect(telemetryUrls.length).toBe(3));
  expect([...telemetryUrls].sort()).toEqual([
    '/api/v1/sites/site-1/fabs/fab-a/telemetry/stream',
    '/api/v1/sites/site-1/fabs/fab-b/telemetry/stream',
    '/api/v1/sites/site-1/fabs/fab-c/telemetry/stream',
  ]);
  // The command SSE stays site-scoped; only telemetry/status are FAB-scoped.
  expect(commandUrls).toEqual(['/api/v1/sites/site-1/commands/stream']);
  await waitFor(() => expect(screen.getByTestId('fab-telemetry').textContent).toBe('fab-b:none'));
  expect(captured?.size).toBe(3);

  view.unmount();
  await waitFor(() => expect(telemetryUrls.every((url) => closed.includes(url))).toBe(true));
});

it('shows a data-driven FAB selector in the workbench when the site has multiple FABs', async () => {
  const client = clientWithSites();
  render(<AppProviders client={client}><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(screen.getByText('XSTATE RUNTIMES')).toBeTruthy());
  const selector = document.querySelector('aside select');
  expect(selector).not.toBeNull();
  expect(selector?.querySelectorAll('option')).toHaveLength(3);
});
