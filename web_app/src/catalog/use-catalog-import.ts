import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import type { ChangeEvent } from 'react';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { localeAtom } from '@/state/locale.atom';
import { text, type Language } from '@/catalog/catalog-labels';
import { parseCatalogEntries } from '@/catalog/catalog-data';
import { catalogActions } from '@/catalog/catalog.atom';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Local JSON preview import; never publishes, approves or mutates server data. */
export interface CatalogImport {
  importFile: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function useCatalogImport(): CatalogImport {
  const registry = useContext(RegistryContext);
  const language = useAtomValue(localeAtom, (state) => state.language);
  return (({
      importFile: (event: ChangeEvent<HTMLInputElement>) => {
        void importCatalogFile(registry, event, language);
      },
    }));
}

async function importCatalogFile(
  registry: AtomRegistry.AtomRegistry,
  event: ChangeEvent<HTMLInputElement>,
  language: Language,
): Promise<void> {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  const requestId = crypto.randomUUID();
  catalogActions.importStarted(registry, requestId);
  if (file.size > MAX_IMPORT_BYTES) {
    catalogActions.importFailed(registry, {
      requestId,
      error: text(language, '文件超过 10 MiB。', 'File exceeds 10 MiB.'),
    });
    return;
  }
  try {
    const parsed: CatalogEntryDto[] = parseCatalogEntries(JSON.parse(await file.text()));
    catalogActions.localImportApplied(registry, { requestId, entries: parsed, importId: file.name });
  } catch (reason: unknown) {
    catalogActions.importFailed(registry, {
      requestId,
      error: reason instanceof Error ? reason.message : text(language, '导入失败', 'Import failed'),
    });
  }
}
