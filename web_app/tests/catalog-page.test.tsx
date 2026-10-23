import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CatalogEntryDto } from '../src/contracts';
import { CatalogComparison, RecordFields } from '../src/catalog-page';

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
