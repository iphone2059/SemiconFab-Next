// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it } from 'vitest';
import { AppProviders } from '../../src/app/providers/AppProviders';
import { useFabRuntimeRegistry } from '../../src/app/providers/RuntimeProvider';
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

it('shows a data-driven FAB selector in the workbench when the site has multiple FABs', async () => {
  const client = clientWithSites();
  render(<AppProviders client={client}><WorkbenchApp /></AppProviders>);
  await waitFor(() => expect(screen.getByText('XSTATE RUNTIMES')).toBeTruthy());
  const selector = document.querySelector('aside select');
  expect(selector).not.toBeNull();
  expect(selector?.querySelectorAll('option')).toHaveLength(3);
});
