import { Schema } from 'effect';
import { nonEmptyString, nonNegativeInteger } from '@/api/primitives.schema';
const record = Schema.Record(Schema.String, Schema.Unknown);
const categorySchema = Schema.Struct({
  category: nonEmptyString, domain: Schema.Literals(['FAB', 'OSAT']), count: nonNegativeInteger,
});
const entrySchema = Schema.Struct({
  // Preserve the published validator's special max-UUID spelling (ordinary UUIDs remain case-insensitive).
  recordId: Schema.String.check(Schema.isUUID(), Schema.makeFilter((id: string) =>
    id.toLowerCase() !== 'ffffffff-ffff-ffff-ffff-ffffffffffff' || id === 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      || 'Invalid max UUID spelling')), vendor: nonEmptyString, model: nonEmptyString,
  category: nonEmptyString, domain: Schema.Literals(['FAB', 'OSAT']),
  conformanceLevel: Schema.Literals(['draft', 'L1', 'L2', 'L3']),
  completenessPct: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 100 })),
  missingFields: Schema.Array(Schema.String).pipe(Schema.mutable), record, legacy: record, price: Schema.NullOr(record),
}).check(Schema.makeFilter(entry => {
  if (entry.record['record_id'] !== entry.recordId) return 'catalog entry record_id mismatch';
  const identity = entry.record['identity'];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return 'catalog entry identity missing';
  for (const key of ['vendor', 'model', 'category'] as const) {
    const field: unknown = Object.getOwnPropertyDescriptor(identity, key)?.value;
    if (!field || typeof field !== 'object' || Array.isArray(field) ||
      Object.getOwnPropertyDescriptor(field, 'value')?.value !== entry[key]) return 'catalog entry identity mismatch: ' + key;
  }
  return entry.domain === (entry.category.startsWith('osat_') ? 'OSAT' : 'FAB') || 'catalog entry domain/category mismatch';
}));
export const catalogPageSchema = Schema.Struct({
  importId: nonEmptyString, totalCount: nonNegativeInteger, matchedCount: nonNegativeInteger,
  categories: Schema.Array(categorySchema).pipe(Schema.mutable), items: Schema.Array(entrySchema).pipe(Schema.mutable).check(Schema.isMaxLength(10000)),
}).check(Schema.makeFilter(page => {
  const ids = new Set<string>();
  for (const entry of page.items) {
    if (ids.has(entry.recordId)) return 'duplicate catalog recordId';
    ids.add(entry.recordId);
  }
  return page.matchedCount <= page.totalCount && page.items.length <= page.matchedCount || 'invalid catalog result counts';
}));
export const decodeCatalogPage = Schema.decodeUnknownEffect(catalogPageSchema);
