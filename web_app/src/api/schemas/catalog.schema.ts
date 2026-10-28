import { z } from 'zod';
import type { CatalogCategoryDto, CatalogEntryDto, CatalogPageDto } from '../../contracts';

const record = z.record(z.string(), z.unknown());
const uuid = z.uuid();

const categorySchema: z.ZodType<CatalogCategoryDto> = z.object({
  category: z.string().min(1),
  domain: z.enum(['FAB', 'OSAT']),
  count: z.number().int().nonnegative(),
});

/**
 * Validate every published entry, not just the HTTP envelope. Deep catalog
 * metadata is a provenance document, while identity and reference integrity
 * are non-negotiable at the server-cache boundary.
 */
const entrySchema: z.ZodType<CatalogEntryDto> = z.object({
  recordId: uuid,
  vendor: z.string().min(1),
  model: z.string().min(1),
  category: z.string().min(1),
  domain: z.enum(['FAB', 'OSAT']),
  conformanceLevel: z.enum(['draft', 'L1', 'L2', 'L3']),
  completenessPct: z.number().finite().min(0).max(100),
  missingFields: z.array(z.string()),
  record,
  legacy: record,
  price: record.nullable(),
}).superRefine((entry, ctx) => {
  if (entry.record['record_id'] !== entry.recordId) {
    ctx.addIssue({ code: 'custom', message: 'catalog entry record_id mismatch', path: ['record', 'record_id'] });
  }
  const identity = entry.record['identity'];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    ctx.addIssue({ code: 'custom', message: 'catalog entry identity missing', path: ['record', 'identity'] });
    return;
  }
  for (const key of ['vendor', 'model', 'category'] as const) {
    const field = Object.getOwnPropertyDescriptor(identity, key)?.value;
    if (!field || typeof field !== 'object' || Array.isArray(field) ||
      Object.getOwnPropertyDescriptor(field, 'value')?.value !== entry[key]) {
      ctx.addIssue({ code: 'custom', message: 'catalog entry identity mismatch: ' + key, path: ['record', 'identity', key] });
    }
  }
  if (entry.domain !== (entry.category.startsWith('osat_') ? 'OSAT' : 'FAB')) {
    ctx.addIssue({ code: 'custom', message: 'catalog entry domain/category mismatch', path: ['domain'] });
  }
});

export const catalogPageSchema: z.ZodType<CatalogPageDto> = z.object({
  importId: z.string().min(1),
  totalCount: z.number().int().nonnegative(),
  matchedCount: z.number().int().nonnegative(),
  categories: z.array(categorySchema),
  items: z.array(entrySchema).max(10000),
}).superRefine((page, ctx) => {
  const ids = new Set<string>();
  for (const [index, entry] of page.items.entries()) {
    if (ids.has(entry.recordId)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate catalog recordId', path: ['items', index, 'recordId'] });
    }
    ids.add(entry.recordId);
  }
  if (page.matchedCount > page.totalCount || page.items.length > page.matchedCount) {
    ctx.addIssue({ code: 'custom', message: 'invalid catalog result counts', path: ['matchedCount'] });
  }
});
