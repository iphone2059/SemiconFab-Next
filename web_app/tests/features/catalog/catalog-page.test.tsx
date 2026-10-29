import { resetCatalogState, resetLocaleState } from '../../../tests/support/reset-ui-atoms';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { RegistryContext } from '@effect/atom-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { CatalogPage } from '@/catalog/catalog-page';
import { CatalogComparison } from '@/catalog/catalog-comparison';
import { FieldValue, RecordFields } from '@/catalog/catalog-fields';
import { ExternalLink } from '@/catalog/external-link';
import { catalogQueryOptions } from '@/api/catalog.resource';



const registry = AtomRegistry.make();
beforeEach(() => {
  resetCatalogState(registry);
  resetLocaleState(registry);
});

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

it('validates provenance URL schemes and renders non-http(s) sources as inert text', () => {
  const field = (source: string) => ({
    path: 'physical.width_mm',
    value: 2300,
    unit: 'mm',
    tier: 'inferred',
    source,
  });

  const safe = renderToStaticMarkup(<FieldValue field={field('https://example.test/spec')} />);
  expect(safe).toContain('href="https://example.test/spec"');
  expect(safe).toContain('target="_blank"');
  expect(safe).toContain('rel="noopener noreferrer"');

  // Every scheme outside the strict http(s) allowlist must stay inert text: it
  // may never become a clickable anchor that executes or navigates.
  for (const source of [
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///etc/passwd',
    'ftp://example.test/spec',
    'mailto:ops@example.test',
    'https://user:pass@example.test/spec',
    '//example.test/spec',
  ]) {
    const html = renderToStaticMarkup(<FieldValue field={field(source)} />);
    expect(html, source).not.toContain('<a');
    expect(html, source).toContain(source);
  }

  expect(
    renderToStaticMarkup(
      <ExternalLink href="javascript:alert(1)" fallback="inert source">
        linked source
      </ExternalLink>,
    ),
  ).toBe('inert source');
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
    <RegistryContext.Provider value={registry}><QueryClientProvider client={queryClient}>
      <CatalogPage
        view="catalog"
        search={{}}
        onSearchChange={() => {}}
        onViewChange={() => {}}
      />
    </QueryClientProvider></RegistryContext.Provider>,
  );
  expect(html).toContain('FPA');
  expect(html).toContain('SNAPSHOT legacy-test');
  expect(html).not.toContain('Catalog request failed');
});
