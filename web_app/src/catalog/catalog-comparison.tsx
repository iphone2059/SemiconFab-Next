import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { catalogFields } from '@/catalog/catalog-data';
import { text, type Language } from '@/catalog/catalog-labels';
import { FieldValue, Price } from '@/catalog/catalog-fields';

/** Side-by-side comparison of the user-selected representation entries. */
export function CatalogComparison({
  entries,
  language,
  onRemove,
}: {
  entries: readonly CatalogEntryDto[];
  language: Language;
  onRemove: (id: string) => void;
}) {
  const fields = (entries.map(
        (entry) => new Map(catalogFields(entry.record).map((field) => [field.path, field])),
      ));
  const paths = ([...new Set(fields.flatMap((map) => [...map.keys()]))].sort());
  if (entries.length === 0)
    return (
      <p className="catalog-empty">
        {text(
          language,
          '从下方目录勾选设备，最多对比 4 项。',
          'Select up to 4 tools from the catalog below.',
        )}
      </p>
    );
  return (
    <div className="catalog-table-scroll">
      <table className="catalog-comparison">
        <thead>
          <tr>
            <th>{text(language, '对比项目', 'Comparison')}</th>
            {entries.map((entry) => (
              <th key={entry.recordId}>
                {entry.vendor}
                <strong>{entry.model}</strong>
                <button onClick={() => onRemove(entry.recordId)}>
                  {text(language, '移除', 'Remove')}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{text(language, '原版等级', 'Legacy level')}</th>
            {entries.map((entry) => (
              <td key={entry.recordId}>
                {entry.conformanceLevel} · {entry.completenessPct}%
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">{text(language, '估算价格 / USD', 'Estimated price / USD')}</th>
            {entries.map((entry) => (
              <td key={entry.recordId}>
                <Price entry={entry} language={language} />
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">{text(language, '缺失字段', 'Missing fields')}</th>
            {entries.map((entry) => (
              <td key={entry.recordId}>{entry.missingFields.join(', ') || '—'}</td>
            ))}
          </tr>
          {paths.map((path) => (
            <tr key={path}>
              <th scope="row">{path}</th>
              {entries.map((entry, index) => (
                <td key={entry.recordId}>
                  <FieldValue field={fields[index]?.get(path)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
