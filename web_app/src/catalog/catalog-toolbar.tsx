import type { ChangeEvent } from 'react';
import type { CatalogDomain } from '@/catalog/catalog-data';
import { text, type Language } from '@/catalog/catalog-labels';

export interface CatalogToolbarProps {
  language: Language;
  domain: CatalogDomain;
  entriesCount: number;
  localPreview: boolean;
  onDomainChange: (domain: CatalogDomain) => void;
  onImportFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onExportCatalog: () => void;
  onRestoreServer: () => void;
}

/** Domain switch, local-JSON import, catalog export and server-catalog restore. */
export function CatalogToolbar({
  language,
  domain,
  entriesCount,
  localPreview,
  onDomainChange,
  onImportFile,
  onExportCatalog,
  onRestoreServer,
}: CatalogToolbarProps) {
  return (
    <div className="catalog-toolbar">
      <div className="catalog-domains" aria-label={text(language, '设备领域', 'Equipment domain')}>
        {(['ALL', 'FAB', 'OSAT'] as const).map((value) => (
          <button key={value} aria-pressed={domain === value} onClick={() => onDomainChange(value)}>
            {value === 'ALL' ? text(language, '全部设备', 'All equipment') : value}
          </button>
        ))}
      </div>
      <label className="catalog-file">
        {text(language, '载入本地 JSON', 'Load local JSON')}
        <input type="file" accept=".json,application/json" onChange={onImportFile} />
      </label>
      <button disabled={!entriesCount} onClick={onExportCatalog}>
        {text(language, '导出目录', 'Export catalog')}
      </button>
      {localPreview && (
        <button onClick={onRestoreServer}>
          {text(language, '恢复服务端目录', 'Restore server catalog')}
        </button>
      )}
    </div>
  );
}
