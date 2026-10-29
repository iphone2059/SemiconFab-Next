import legacyLicenseUrl from '../../assets/legacy-LICENSE.txt';
import { text, type Language } from '@/catalog/catalog-labels';

/** Catalog footer: the license link points at the bundled authoritative asset. */
export function CatalogFooter({ language }: { language: Language }) {
  return (
    <footer className="catalog-footer">
      <span>
        SEMICONFAB NEXT ·{' '}
        <a href={legacyLicenseUrl} target="_blank" rel="noopener noreferrer">
          {text(language, '数据许可', 'Data license')}
        </a>
      </span>
      <span>
        {text(
          language,
          '原始数据与来源保留 · 型号目录独立于运行状态',
          'Original data & provenance preserved · Catalog independent of Run state',
        )}
      </span>
    </footer>
  );
}
