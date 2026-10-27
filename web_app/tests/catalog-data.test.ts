import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  catalogFields,
  filterCatalog,
  parseCatalogEntries,
  safeExternalUrl,
} from '../src/features/catalog/catalog-data';
import { catalogSearchFrom } from '../src/app/router/search';

const pointer = JSON.parse(
  readFileSync(new URL('../../assets/legacy/current.json', import.meta.url), 'utf8'),
) as { importId: string };
const legacy = JSON.parse(
  readFileSync(
    new URL(`../../assets/legacy/${pointer.importId}/raw/catalog.json`, import.meta.url),
    'utf8',
  ),
) as unknown[];

it('imports the full legacy array without losing identity or field provenance', () => {
  const entries = parseCatalogEntries(legacy);
  expect(entries).toHaveLength(253);
  expect(entries[0].recordId).toBe('3acd7b05-e6e8-5312-bb5b-045e7dd3074b');
  expect(entries[0].legacy).toEqual(legacy[0]);
  expect(filterCatalog(entries, 'OSAT', '', '')).toHaveLength(86);
  expect(filterCatalog(entries, 'ALL', '', '', true)).toHaveLength(9);
  expect(filterCatalog(entries, 'OSAT', '', '', true).map((entry) => entry.model)).toEqual([
    'SS20',
  ]);
  expect(filterCatalog(entries, 'FAB', '', 'fpa-5550iz2').map((e) => e.vendor)).toEqual(['Canon']);
  expect(entries[0].price).toBeNull();
});

it('rejects corrupt imports and duplicated identities before replacing visible data', () => {
  expect(() => parseCatalogEntries([...legacy, legacy[0]])).toThrow(/重复|duplicate/i);
  expect(() => parseCatalogEntries([{ ...(legacy[0] as object), vendor: 'Mismatch' }])).toThrow();
  expect(() => parseCatalogEntries({ arbitrary: [] })).toThrow();
});

it('flattens value/provenance fields for inspection and comparison', () => {
  const entry = parseCatalogEntries(legacy)[0];
  expect(catalogFields(entry.record)).toContainEqual(
    expect.objectContaining({
      path: 'physical.width_mm',
      value: 2300,
      unit: 'mm',
      tier: 'inferred',
    }),
  );
  expect(catalogFields(entry.record)).toContainEqual(
    expect.objectContaining({ path: 'identity.vendor', value: 'Canon', tier: 'vendor_confirmed' }),
  );
});

it('parses canonical comparison query semantics with bounded, deduplicated ids', () => {
  const ids = ['3acd7b05-e6e8-5312-bb5b-045e7dd3074b', 'e3021724-ec73-534e-be7c-ba3374f4ddb8'];
  const route = catalogSearchFrom({
    compare: `${ids[0]},${ids[0]},${ids[1]}`,
    domain: 'osat',
    category: 'lithography',
  });
  expect(route.domain).toBe('OSAT');
  expect(route.compare).toEqual(ids);
  expect(route.category).toBe('lithography');
});

it('does not turn arbitrary provenance strings into executable links', () => {
  expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
  expect(safeExternalUrl('data:text/html,test')).toBeUndefined();
  expect(safeExternalUrl('segment mapping v1.0')).toBeUndefined();
  expect(safeExternalUrl('https://example.test/spec')).toBe('https://example.test/spec');
});
