import { useMemo, type ChangeEvent } from 'react';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { useLocaleStore } from '@/state/locale.atom';
import { text, type Language } from '@/catalog/catalog-labels';
import { parseCatalogEntries } from '@/catalog/catalog-data';
import { catalogActions } from '@/catalog/catalog.atom';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Local JSON preview import; never publishes, approves or mutates server data. */
export interface CatalogImport {
  importFile: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function useCatalogImport(): CatalogImport {
  const language = useLocaleStore((state) => state.language);
  return useMemo(
    () => ({
      importFile: (event: ChangeEvent<HTMLInputElement>) => {
        void importCatalogFile(event, language);
      },
    }),
    [language],
  );
}

async function importCatalogFile(
  event: ChangeEvent<HTMLInputElement>,
  language: Language,
): Promise<void> {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  const requestId = crypto.randomUUID();
  catalogActions.importStarted(requestId);
  if (file.size > MAX_IMPORT_BYTES) {
    catalogActions.importFailed({
      requestId,
      error: text(language, '文件超过 10 MiB。', 'File exceeds 10 MiB.'),
    });
    return;
  }
  try {
    const parsed: CatalogEntryDto[] = parseCatalogEntries(JSON.parse(await file.text()));
    catalogActions.localImportApplied({ requestId, entries: parsed, importId: file.name });
  } catch (reason: unknown) {
    catalogActions.importFailed({
      requestId,
      error: reason instanceof Error ? reason.message : text(language, '导入失败', 'Import failed'),
    });
  }
}
