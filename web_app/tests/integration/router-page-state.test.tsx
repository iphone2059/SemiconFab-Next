// @vitest-environment jsdom
import { installNativeDialogPolyfill } from '../support/native-dialog.ts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

installNativeDialogPolyfill();
import { CatalogPage } from '@/catalog/catalog-page';
import { TwinPage } from '@/twin/twin-page';
import { resetCatalogStore } from '@/catalog/catalog.atom';
import { useLocaleStore } from '@/state/locale.atom';
import { resetTwinUiStore, useTwinUiStore } from '@/twin/twin-ui.atom';
import { resetTwinPageStore } from '@/twin/twin-page.atom';
import { resetRuntimeStore } from '@/state/runtime-store';
import { catalogQueryOptions } from '@/api/catalog.resource';
import { sitesQueryOptions } from '@/api/sites.resource';
import type { RouterSearch } from '@/routes/route-search';

// Only replace the hardware boundary; pages, stores and effects remain real.
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../support/scene-port-stub.ts');
  return { createLiteBackend: () => createScenePortStub() };
});

let client: QueryClient;
beforeEach(() => {
  resetCatalogStore(); resetTwinUiStore(); resetTwinPageStore(); resetRuntimeStore();
  useLocaleStore.setState({ language: 'zh', theme: 'light' }, true);
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(catalogQueryOptions().queryKey, { importId: 'test', items: [], totalCount: 0, matchedCount: 0, categories: [] });
  client.setQueryData(sitesQueryOptions().queryKey, [{ siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] }]);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

it('preserves catalog deep-link filters and locale instead of writing initial store values back', () => {
  const search: RouterSearch = { domain: 'osat', q: 'SENTINEL', lang: 'en-US', theme: 'dark' };
  const updates: Partial<RouterSearch>[] = [];
  render(<QueryClientProvider client={client}><CatalogPage view="catalog" search={search} onSearchChange={patch => updates.push(patch)} onViewChange={() => {}} /></QueryClientProvider>);
  for (const patch of updates) expect({ ...search, ...patch }).toMatchObject(search);
  expect(useLocaleStore.getState()).toEqual({ language: 'en', theme: 'dark' });
});

it('accepts changed URL input and still writes subsequent user edits', () => {
  const updates: Partial<RouterSearch>[] = [];
  const onSearchChange = (patch: Partial<RouterSearch>) => { updates.push(patch); };
  const page = (search: RouterSearch) => <QueryClientProvider client={client}><CatalogPage view="catalog" search={search} onSearchChange={onSearchChange} onViewChange={() => {}} /></QueryClientProvider>;
  const view = render(page({ q: 'first', lang: 'en-US', theme: 'dark' }));
  updates.length = 0;
  view.rerender(page({ q: 'back-forward', lang: 'en-US', theme: 'dark' }));
  for (const patch of updates) expect(patch.q ?? 'back-forward').toBe('back-forward');
  fireEvent.change(view.getByPlaceholderText('Vendor, model or category…'), { target: { value: 'user-edit' } });
  expect(updates.at(-1)?.q).toBe('user-edit');
});

it('preserves Twin research and locale deep links during initial hydration', () => {
  const search: RouterSearch = { mode: 'research', lang: 'en-US', theme: 'dark', modal: 'arch' };
  const updates: Partial<RouterSearch>[] = [];
  render(<QueryClientProvider client={client}><TwinPage fabId="fab-1" search={search} onSearchChange={patch => updates.push(patch)} /></QueryClientProvider>);
  for (const patch of updates) expect({ ...search, ...patch }).toMatchObject(search);
  expect(useTwinUiStore.getState().entryMode).toBe('research');
  expect(useLocaleStore.getState()).toEqual({ language: 'en', theme: 'dark' });
});
