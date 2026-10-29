import { useMemo } from 'react';
import type { CatalogEntryDto } from '@/contracts/app-contracts';
import { catalogFields, type CatalogField } from '@/catalog/catalog-data';
import { ExternalLink } from '@/catalog/external-link';
import { text, valueText, type Language } from '@/catalog/catalog-labels';

export function Price({ entry, language }: { entry: CatalogEntryDto; language: Language }) {
  const low = entry.price?.low_usd;
  const high = entry.price?.high_usd;
  if (
    typeof low !== 'number' ||
    typeof high !== 'number' ||
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  )
    return <span className="catalog-muted">{text(language, '暂无估价', 'Not available')}</span>;
  const format = new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  return (
    <span>
      {format.format(low)} – {format.format(high)}
      <small>
        {valueText(entry.price?.as_of)} · {valueText(entry.price?.basis)}
      </small>
    </span>
  );
}

export function FieldValue({ field }: { field: CatalogField | undefined }) {
  if (!field) return <>—</>;
  return (
    <>
      <span>
        {valueText(field.value)}
        {field.unit && ` ${field.unit}`}
      </span>
      {field.tier && <small>{field.tier}</small>}
      {field.source && (
        <small>
          <ExternalLink href={field.source} fallback={field.source}>
            {field.source} ↗
          </ExternalLink>
        </small>
      )}
    </>
  );
}

export function RecordFields({ entry, language }: { entry: CatalogEntryDto; language: Language }) {
  const fields = useMemo(() => catalogFields(entry.record), [entry.record]);
  return (
    <div className="catalog-table-scroll">
      <table className="catalog-field-table">
        <thead>
          <tr>
            <th>{text(language, '字段', 'Field')}</th>
            <th>{text(language, '值、单位与来源', 'Value, unit & provenance')}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.path}>
              <th scope="row">{field.path}</th>
              <td>
                <FieldValue field={field} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
