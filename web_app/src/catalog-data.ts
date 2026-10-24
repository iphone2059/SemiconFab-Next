import type { CatalogEntryDto } from './contracts';

export type CatalogDomain = 'ALL' | 'FAB' | 'OSAT';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readCatalogRoute(url: URL) {
  const domain = url.searchParams.get('domain')?.toUpperCase();
  return {
    view: ['/compare', '/compare.html'].includes(url.pathname)
      ? ('compare' as const)
      : ['/catalog', '/catalog-demo', '/catalog-demo.html'].includes(url.pathname)
        ? ('catalog' as const)
        : ['/preview', '/preview.html'].includes(url.pathname)
          ? ('preview' as const)
          : ('workbench' as const),
    domain: (domain === 'OSAT' || domain === 'FAB' ? domain : 'ALL') as CatalogDomain,
    category: url.searchParams.get('category') ?? '',
    query: url.searchParams.get('q') ?? '',
    hideDrafts: url.searchParams.get('hideDrafts') === '1',
    compare: [
      ...new Set(
        (url.searchParams.get('compare') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => uuid.test(s)),
      ),
    ].slice(0, 4),
  };
}

export function filterCatalog(
  entries: readonly CatalogEntryDto[],
  domain: CatalogDomain,
  category: string,
  query: string,
  hideDrafts = false,
): CatalogEntryDto[] {
  const term = query.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      (!hideDrafts || entry.conformanceLevel !== 'draft') &&
      (domain === 'ALL' || entry.domain === domain) &&
      (!category || entry.category === category) &&
      (!term ||
        [entry.vendor, entry.model, entry.category].some((value) =>
          value.toLocaleLowerCase().includes(term),
        )),
  );
}

/** Browser-only preview; never publishes a catalog or grants approval. */
export function parseCatalogEntries(input: unknown): CatalogEntryDto[] {
  const rows = Array.isArray(input)
    ? input
    : object(input) && Array.isArray(input.entries)
      ? input.entries
      : undefined;
  if (!rows || rows.length > 10000) throw new Error('设备目录格式无效 / Invalid catalog format');
  const seen = new Set<string>();
  return rows.map((row: unknown, index) => {
    if (!object(row)) throw new Error(`记录 ${index + 1} 无效 / Invalid record`);
    const normalized = typeof row.recordId === 'string';
    const id = normalized ? row.recordId : row.record_id;
    if (typeof id !== 'string' || !uuid.test(id))
      throw new Error(`记录 ${index + 1} UUID 无效 / Invalid UUID`);
    if (seen.has(id)) throw new Error(`重复设备 UUID / Duplicate ID: ${id}`);
    seen.add(id);
    if (!object(row.record) || !object(row.record.identity) || row.record.record_id !== id)
      throw new Error(`原始记录缺失或 ID 不一致 / Missing or mismatched record: ${id}`);
    for (const key of ['vendor', 'model', 'category']) {
      const inner = row.record.identity[key];
      if (
        typeof row[key] !== 'string' ||
        !row[key].trim() ||
        !object(inner) ||
        inner.value !== row[key]
      )
        throw new Error(`设备身份不一致 / Identity mismatch: ${id}`);
    }
    const level = normalized ? row.conformanceLevel : row.conformance_level;
    const percentage = normalized ? row.completenessPct : row.completeness_pct;
    const missing = normalized ? row.missingFields : row.missing_fields;
    if (
      typeof level !== 'string' ||
      !['draft', 'L1', 'L2', 'L3'].includes(level) ||
      typeof percentage !== 'number' ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100 ||
      !Array.isArray(missing) ||
      missing.some((value) => typeof value !== 'string') ||
      (normalized && !object(row.legacy)) ||
      (normalized && row.price !== null && !object(row.price))
    )
      throw new Error(`目录元数据无效 / Invalid metadata: ${id}`);
    const category = row.category as string;
    return {
      recordId: id,
      vendor: row.vendor as string,
      model: row.model as string,
      category,
      domain: category.startsWith('osat_') ? 'OSAT' : 'FAB',
      conformanceLevel: level,
      completenessPct: percentage,
      missingFields: missing as string[],
      record: row.record,
      legacy: normalized ? (row.legacy as Record<string, unknown>) : row,
      price: normalized ? (row.price as Record<string, unknown> | null) : null,
    };
  });
}

export interface CatalogField {
  path: string;
  value: unknown;
  unit: string;
  tier: string;
  source: string;
}
export function catalogFields(record: Readonly<Record<string, unknown>>): CatalogField[] {
  const fields: CatalogField[] = [];
  function visit(value: unknown, path: string): void {
    if (object(value)) {
      if ('value' in value) {
        const provenance = object(value.provenance) ? value.provenance : {};
        fields.push({
          path,
          value: value.value,
          unit: typeof value.unit === 'string' ? value.unit : '',
          tier: typeof provenance.tier === 'string' ? provenance.tier : '',
          source: typeof provenance.source === 'string' ? provenance.source : '',
        });
      } else
        for (const [key, child] of Object.entries(value))
          visit(child, path ? `${path}.${key}` : key);
    } else if (Array.isArray(value) && value.some(object))
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
    else fields.push({ path, value, unit: '', tier: '', source: '' });
  }
  visit(record, '');
  return fields;
}

export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* Provenance may be plain text. */
  }
}
