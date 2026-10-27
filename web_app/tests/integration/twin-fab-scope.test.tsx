// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TwinPage } from '../../src/features/twin/twin-page';
import { sitesQueryOptions } from '../../src/api/queries/sites.queries';
import { resetTwinUiStore } from '../../src/state/twinUiStore';
import { resetTwinPageStore } from '../../src/state/twinPageStore';
import { resetRuntimeStore } from '../../src/state/runtimeStore';
import { resetTwinDemoStore } from '../../src/state/twinDemoStore';

const backend = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../../src/lite-backend', () => ({
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

afterEach(() => {
  cleanup();
  backend.mounts = 0;
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
