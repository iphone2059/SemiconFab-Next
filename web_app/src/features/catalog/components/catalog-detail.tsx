import type { CatalogEntryDto } from '../../../contracts';
import { Modal, ModalTitle } from '../../../components/modal';
import { categoryText, text, type Language } from '../labels';
import { Price, RecordFields } from './catalog-fields';

/**
 * Native-dialog detail view. The Modal wrapper stays the single Dialog
 * implementation; this file only owns the catalog detail content.
 */
export function EquipmentDetails({
  entry,
  language,
  onClose,
  onDownloadRecord,
}: {
  entry: CatalogEntryDto;
  language: Language;
  onClose: () => void;
  onDownloadRecord: (entry: CatalogEntryDto) => void;
}) {
  return (
    <Modal
      className="catalog-dialog"
      backdropClassName="catalog-dialog-backdrop"
      onClose={onClose}
    >
      <div className="catalog-dialog-head">
        <div>
          <span className="catalog-eyebrow">{entry.vendor}</span>
          <ModalTitle asChild><h2>{entry.model}</h2></ModalTitle>
          <span className="catalog-muted">{entry.recordId}</span>
        </div>
        <button onClick={onClose} autoFocus>
          {text(language, '关闭', 'Close')} ×
        </button>
      </div>
      <div className="catalog-dialog-body">
        <p>
          {categoryText(entry.category, language)} · {entry.conformanceLevel} ·{' '}
          {entry.completenessPct}%
        </p>
        <p className="catalog-notice">
          {text(
            language,
            '等级与完整度保留原版标签，尚未重新进行完整标准校验。',
            'Level and completeness are preserved legacy labels; full conformance has not been revalidated.',
          )}
        </p>
        <p>
          <Price entry={entry} language={language} />
        </p>
        <p>
          {text(language, '缺失字段：', 'Missing fields: ')}
          {entry.missingFields.join(', ') || '—'}
        </p>
        <RecordFields entry={entry} language={language} />
        <details>
          <summary>
            {text(language, '完整原始记录与估价', 'Complete original record & estimate')}
          </summary>
          <pre>
            {JSON.stringify(
              { record: entry.record, price: entry.price, legacy: entry.legacy },
              null,
              2,
            )}
          </pre>
        </details>
        <button onClick={() => onDownloadRecord(entry)}>
          {text(language, '下载设备记录 JSON', 'Download equipment record JSON')}
        </button>
      </div>
    </Modal>
  );
}
