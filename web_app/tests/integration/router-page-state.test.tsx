// @vitest-environment jsdom
import { resetCatalogState, resetRuntimeState, resetTwinPageState, resetTwinUiState } from '../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../tests/support/atom-scope';
import { installNativeDialogPolyfill } from '../../tests/support/native-dialog';
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestRuntime, seedCatalog, seedSites, ResourceTestProviders, type AppRuntime } from '../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
installNativeDialogPolyfill();
import { CatalogPage } from '@/catalog/catalog-page';
import { TwinPage } from '@/twin/twin-page';

import { localeAtom } from '@/state/locale.atom';
import { twinUiAtom } from '@/twin/twin-ui.atom';


import type { RouterSearch } from '@/routes/route-search';

// Only replace the hardware boundary; pages, stores and effects remain real.
vi.mock('../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../../tests/support/scene-port-stub');
  return { createLiteBackend: () => createScenePortStub() };
});

let client: AppRuntime<never>;
beforeEach(() => {
  resetCatalogState(registry); resetTwinUiState(registry); resetTwinPageState(registry); resetRuntimeState(registry);
  registry.set(localeAtom, { language: 'zh', theme: 'light' });
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} });
  client = createTestRuntime(registry);
  seedCatalog(client, { importId: 'test', items: [], totalCount: 0, matchedCount: 0, categories: [] });
  seedSites(client, [{ siteId: 'site-1', code: 'SITE-1', templateHash: 'test', fabs: [{ fabId: 'fab-1', code: 'FAB-01' }] }]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('preserves catalog deep-link filters and locale instead of writing initial store values back', () => {
  const search: RouterSearch = { domain: 'osat', q: 'SENTINEL', lang: 'en-US', theme: 'dark' };
  const updates: Partial<RouterSearch>[] = [];
  render(<ResourceTestProviders runtime={client}><CatalogPage view="catalog" search={search} onSearchChange={patch => updates.push(patch)} onViewChange={() => {}} /></ResourceTestProviders>);
  for (const patch of updates) expect({ ...search, ...patch }).toMatchObject(search);
  expect(registry.get(localeAtom)).toEqual({ language: 'en', theme: 'dark' });
});

it('accepts changed URL input and still writes subsequent user edits', () => {
  const updates: Partial<RouterSearch>[] = [];
  const onSearchChange = (patch: Partial<RouterSearch>) => { updates.push(patch); };
  const page = (search: RouterSearch) => <ResourceTestProviders runtime={client}><CatalogPage view="catalog" search={search} onSearchChange={onSearchChange} onViewChange={() => {}} /></ResourceTestProviders>;
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
  render(<ResourceTestProviders runtime={client}><TwinPage fabId="fab-1" search={search} onSearchChange={patch => updates.push(patch)} /></ResourceTestProviders>);
  for (const patch of updates) expect({ ...search, ...patch }).toMatchObject(search);
  expect(registry.get(twinUiAtom).entryMode).toBe('research');
  expect(registry.get(localeAtom)).toEqual({ language: 'en', theme: 'dark' });
});
