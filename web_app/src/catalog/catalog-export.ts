import type { CatalogEntryDto } from '@/contracts/app-contracts';

/**
 * Downloaded catalog document. Its shape is the Catalog representation schema
 * (normalized CatalogEntryDto rows); the raw Equipment Reference rows stay in
 * each entry's `record`/`legacy` fields for traceability but never become the
 * document's top-level identity. Bumping the layout requires contractVersion 2.
 */
export interface CatalogExportDocument {
  readonly contractVersion: 1;
  readonly importId: string;
  readonly source: 'LOCAL_PREVIEW' | 'SemiconFab-main';
  readonly entries: readonly CatalogEntryDto[];
}

export const CATALOG_EXPORT_FILENAME = 'semiconfab-catalog.json';

/** Build the export document from the representation entries the page displays. */
export function catalogExportDocument(
  entries: readonly CatalogEntryDto[],
  options: { importId: string; localPreview: boolean },
): CatalogExportDocument {
  return {
    contractVersion: 1,
    importId: options.importId,
    source: options.localPreview ? 'LOCAL_PREVIEW' : 'SemiconFab-main',
    entries,
  };
}

/** One equipment record export keeps its stable record id as the filename. */
export function catalogRecordFilename(recordId: string): string {
  return `${recordId}.json`;
}
