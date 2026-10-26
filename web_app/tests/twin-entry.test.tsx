import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import WorkbenchApp from '../src/workbench';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { store } from '../src/store/store';
import { readCatalogRoute } from '../src/catalog-data';
import { sitesQueryOptions } from '../src/api/queries/sites.queries';
import { workbenchActions } from '../src/store/workbenchSlice';

const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'hash', fabs: [{ fabId: 'fab-1', code: 'FAB-1' }] };

it('resolves canonical and permanent legacy paths to the same route views', () => {
  for (const path of ['/fabs/fab-1/3d', '/fabs/fab-1', '/twin', '/twin.html', '/preview', '/preview.html']) {
    expect(readCatalogRoute(new URL(`https://example.test${path}`)).view).toBe('twin');
  }
  expect(readCatalogRoute(new URL('https://example.test/equipment')).view).toBe('catalog');
  expect(readCatalogRoute(new URL('https://example.test/equipment/compare')).view).toBe('compare');
  expect(readCatalogRoute(new URL('https://example.test/')).view).toBe('workbench');
});

it('keeps the website entrance free of 3D preview rendering and links to the canonical 3D URL', () => {
  // Static markup does not run effects, so mirror the hydrated site selection.
  store.dispatch(workbenchActions.siteIdSet('site-1'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sitesQueryOptions().queryKey, [site]);
  const html = renderToStaticMarkup(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <WorkbenchApp />
      </QueryClientProvider>
    </Provider>,
  );
  expect(html).toContain('href="/fabs/fab-1/3d"');
  expect(html).toContain('href="/equipment"');
  expect(html).not.toContain('href="/twin"');
  expect(html).not.toContain('<canvas');
  expect(html).not.toContain('SITE DIGITAL VIEW');
  expect(html).not.toContain('预览');
  expect(html).not.toContain('/preview');
});
