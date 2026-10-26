import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider } from 'react-redux';
import type { CatalogEntryDto } from '../src/contracts';
import { CatalogComparison, CatalogPage, RecordFields } from '../src/catalog-page';
import { catalogQueryOptions } from '../src/api/queries/catalog.queries';
import { store } from '../src/store/store';

const entry: CatalogEntryDto = {
  recordId: '3acd7b05-e6e8-5312-bb5b-045e7dd3074b',
  vendor: 'Canon',
  model: 'FPA',
  category: 'lithography',
  domain: 'FAB',
  conformanceLevel: 'draft',
  completenessPct: 50,
  missingFields: ['physical.depth_mm'],
  price: null,
  legacy: {},
  record: {
    physical: {
      width_mm: {
        value: 2300,
        unit: 'mm',
        provenance: { tier: 'inferred', source: 'https://example.test/spec' },
      },
    },
    notes: '<script>alert(1)</script>',
  },
};

// A normalized entry that satisfies parseCatalogEntries so the page can render it
// from the seeded Query cache without mocking the network.
const serverEntry: CatalogEntryDto = {
  ...entry,
  record: {
    record_id: entry.recordId,
    identity: {
      vendor: { value: entry.vendor },
      model: { value: entry.model },
      category: { value: entry.category },
    },
    physical: {
      width_mm: {
        value: 2300,
        unit: 'mm',
        provenance: { tier: 'inferred', source: 'https://example.test/spec' },
      },
    },
  },
};

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

it('shows original values, units and provenance while escaping imported markup', () => {
  const html = renderToStaticMarkup(<RecordFields entry={entry} language="en" />);
  expect(html).toContain('2300 mm');
  expect(html).toContain('inferred');
  expect(html).toContain('https://example.test/spec');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

it('compares unioned fields without hiding missing fields or inventing a zero price', () => {
  const other = {
    ...entry,
    recordId: 'e3021724-ec73-534e-be7c-ba3374f4ddb8',
    model: 'Other',
    record: {
      physical: { depth_mm: { value: 3600, unit: 'mm', provenance: { tier: 'vendor_confirmed' } } },
    },
  };
  const html = renderToStaticMarkup(
    <CatalogComparison entries={[entry, other]} language="en" onRemove={() => {}} />,
  );
  expect(html).toContain('physical.width_mm');
  expect(html).toContain('physical.depth_mm');
  expect(html).toContain('Not available');
  expect(html).not.toContain('$0');
});

it('renders the migrated catalog page from the shared Query cache', () => {
  // The catalog endpoint now lives in TanStack Query (ARCH G-02); seed one
  // isolated cache per render instead of a bespoke RTK store entry.
  const queryClient = createQueryClient();
  queryClient.setQueryData(catalogQueryOptions().queryKey, {
    importId: 'legacy-test',
    totalCount: 1,
    matchedCount: 1,
    categories: [{ category: 'lithography', domain: 'FAB', count: 1 }],
    items: [serverEntry],
  });
  const html = renderToStaticMarkup(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <CatalogPage view="catalog" />
      </QueryClientProvider>
    </Provider>,
  );
  expect(html).toContain('FPA');
  expect(html).toContain('SNAPSHOT legacy-test');
  expect(html).not.toContain('Catalog request failed');
});
