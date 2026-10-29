// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkbenchApp from '@/workbench/workbench';
import { sitesQueryOptions } from '@/api/sites.resource';
import { resetWorkbenchStore, workbenchActions } from '@/workbench/workbench.atom';

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'hash', fabs: [{ fabId: 'fab-1', code: 'FAB-1' }] };

beforeEach(() => resetWorkbenchStore());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps the website entrance free of 3D preview rendering and links to the canonical 3D URL', () => {
  // A client render (unlike static markup) reads the live Zustand snapshot, so
  // mirror the hydrated site selection before mounting the entrance.
  workbenchActions.siteIdSet('site-1');
  // Keep background refetches pending instead of touching the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sitesQueryOptions().queryKey, [site]);
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <WorkbenchApp />
    </QueryClientProvider>,
  );
  expect(container.innerHTML).toContain('href="/fabs/fab-1/3d"');
  expect(container.innerHTML).toContain('href="/equipment"');
  expect(container.innerHTML).not.toContain('<canvas');
  expect(container.innerHTML).not.toContain('SITE DIGITAL VIEW');
  expect(container.innerHTML).not.toContain('预览');
});
