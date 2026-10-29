import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { categoryText, text, type Language } from '@/catalog/catalog-labels';
import { Price } from '@/catalog/catalog-fields';

export interface CatalogTableProps {
  language: Language;
  loading: boolean;
  error: string;
  entries: readonly CatalogEntryDto[];
  filteredCount: number;
  localPreview: boolean;
  importId: string;
  selected: readonly string[];
  currentPage: number;
  pageCount: number;
  onToggle: (id: string) => void;
  onInspect: (id: string) => void;
  onPageChange: (page: number) => void;
}

/** Filtered result count, the paged representation table and its pagination. */
export function CatalogTable({
  language,
  loading,
  error,
  entries,
  filteredCount,
  localPreview,
  importId,
  selected,
  currentPage,
  pageCount,
  onToggle,
  onInspect,
  onPageChange,
}: CatalogTableProps) {
  return (
    <>
      <div className="catalog-result-heading">
        <span aria-live="polite">
          {loading
            ? text(language, '正在读取目录…', 'Loading catalog…')
            : text(language, `找到 ${filteredCount} 条设备`, `${filteredCount} tools found`)}
        </span>
        <span className="catalog-muted">
          {localPreview ? 'LOCAL PREVIEW' : importId ? `SNAPSHOT ${importId.slice(0, 12)}` : ''}
        </span>
      </div>
      <div className="catalog-table-scroll">
        <table className="catalog-list">
          <thead>
            <tr>
              <th>{text(language, '对比', 'Compare')}</th>
              <th>{text(language, '设备型号', 'Equipment')}</th>
              <th>{text(language, '分类', 'Category')}</th>
              <th>{text(language, '原版等级 / 完整度', 'Legacy level / completeness')}</th>
              <th>{text(language, '估算价格 / USD', 'Estimated price / USD')}</th>
              <th>{text(language, '详情', 'Details')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.recordId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={text(language, `对比 ${entry.model}`, `Compare ${entry.model}`)}
                    checked={selected.includes(entry.recordId)}
                    disabled={selected.length >= 4 && !selected.includes(entry.recordId)}
                    onChange={() => onToggle(entry.recordId)}
                  />
                </td>
                <td>
                  <strong>{entry.model}</strong>
                  <small>{entry.vendor}</small>
                </td>
                <td>{categoryText(entry.category, language)}</td>
                <td>
                  <span className="catalog-level">{entry.conformanceLevel}</span>{' '}
                  {entry.completenessPct}%
                  <small>
                    {text(
                      language,
                      `缺失 ${entry.missingFields.length} 项`,
                      `${entry.missingFields.length} missing fields`,
                    )}
                  </small>
                </td>
                <td>
                  <Price entry={entry} language={language} />
                </td>
                <td>
                  <button
                    onClick={() => onInspect(entry.recordId)}
                    aria-label={text(language, `查看 ${entry.model}`, `Inspect ${entry.model}`)}
                  >
                    {text(language, '查看规格', 'Inspect')} ↗
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && filteredCount === 0 && (
        <p className="catalog-empty">
          {error
            ? text(
                language,
                '暂无可用目录，请重试或载入本地 JSON。',
                'Catalog unavailable. Retry or load local JSON.',
              )
            : text(language, '没有匹配设备，请调整筛选条件。', 'No matching tools. Adjust the filters.')}
        </p>
      )}
      <div className="catalog-pagination">
        <button disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>
          {text(language, '上一页', 'Previous')}
        </button>
        <span>
          {currentPage + 1} / {pageCount}
        </span>
        <button disabled={currentPage >= pageCount - 1} onClick={() => onPageChange(currentPage + 1)}>
          {text(language, '下一页', 'Next')}
        </button>
      </div>
    </>
  );
}
