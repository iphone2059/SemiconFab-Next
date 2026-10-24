import type { CatalogEntryDto } from './contracts';
import type { PickedTool } from './fab-scene';
import { FAB_TOOL_STATE_META } from './fab-layout';
import { catalogFields, safeExternalUrl } from './catalog-data';

export function matchToolCatalog(tool: PickedTool, entries: readonly CatalogEntryDto[]): CatalogEntryDto | undefined {
  const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
  const matches = entries.filter(entry => same(entry.vendor, tool.vendor) && same(entry.model, tool.model));
  return matches.length === 1 ? matches[0] : undefined;
}

const labels: Record<string, string> = {
  wafer_sizes_mm: '晶圆尺寸 (mm)', node_applicability: '适用节点', width_mm: '宽度', depth_mm: '深度',
  height_mm: '高度', weight_kg: '重量', detail: '工艺能力', process: '工艺', throughput_wph: '标称产能',
  power_kw: '电力', upw_lpm: '超纯水', pcw_lpm: '冷却水', exhaust_m3h: '排气', notes: '说明',
};
const displayValue = (value: unknown): string => value === null || value === undefined || value === ''
  ? '—' : Array.isArray(value) ? value.map(displayValue).join(' / ')
    : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function FabToolInspector({ tool, entry, loading, categoryLabel, onClose, onFocus }: {
  tool: PickedTool; entry?: CatalogEntryDto; loading?: boolean; categoryLabel?: string; onClose: () => void; onFocus: () => void;
}) {
  const state = FAB_TOOL_STATE_META[tool.state];
  const fields = entry ? catalogFields(entry.record).filter(field => /^(identity\.(wafer_sizes_mm|node_applicability)|physical\.|process_capability\.|utilities\.|facilities\.|notes$)/.test(field.path)) : [];
  const sourceUrls = [...new Set(entry ? catalogFields(entry.record).map(field => safeExternalUrl(field.source)).filter((value): value is string => !!value) : [])];
  return (
    <aside className="scene-toolcard" aria-label="设备详情" aria-live="polite">
      <div className="scene-toolcard-head">
        <span className="technical">SELECTED TOOL · {String(tool.index + 1).padStart(3, '0')}</span>
        <div className="scene-toolcard-actions">
          <button type="button" className="scene-toolcard-focus" onClick={onFocus}>定位</button>
          <button type="button" onClick={onClose} aria-label="关闭设备详情">×</button>
        </div>
      </div>
      <strong>{tool.vendor}</strong>
      <h3>{tool.model}</h3>
      <div className="scene-toolcard-badges">
        <span className="scene-toolcard-category">{categoryLabel ?? tool.category}</span>
        <span className="scene-toolcard-state" style={{ color: state.color, borderColor: `${state.color}40`, background: `${state.color}12` }}>
          <i style={{ background: state.color }} />{state.label}
        </span>
        {entry && <span className="scene-toolcard-category">{[...new Set([entry.conformanceLevel, String(entry.record.record_status ?? '—')])].join(' · ')}</span>}
      </div>
      <dl>
        <div><dt>外形 W × D × H</dt><dd>{tool.width.toFixed(1)} × {tool.depth.toFixed(1)} × {tool.height.toFixed(1)} m</dd></div>
        <div><dt>坐标 X / Z</dt><dd>{tool.x.toFixed(1)} / {tool.z.toFixed(1)} m</dd></div>
      </dl>
      {loading && <p className="scene-toolcard-note">正在读取 OEM 资料…</p>}
      {!loading && !entry && <p className="scene-toolcard-note">暂无唯一匹配的 OEM 资料</p>}
      {fields.length > 0 && <details className="scene-toolcard-specs" open>
        <summary>规格与工艺能力</summary>
        <dl>{fields.map(field => (
          <div key={field.path} title={field.source || undefined}>
            <dt>{labels[field.path.split('.').at(-1) ?? ''] ?? field.path.split('.').at(-1)?.replaceAll('_', ' ')}</dt>
            <dd>{displayValue(field.value)}{field.unit && ` ${field.unit}`}{field.tier && <small>{field.tier}</small>}</dd>
          </div>
        ))}</dl>
      </details>}
      {sourceUrls.length > 0 && <details className="scene-toolcard-sources">
        <summary>资料来源 · {sourceUrls.length}</summary>
        {sourceUrls.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{index + 1}. {new URL(url).hostname} ↗</a>)}
      </details>}
      <a className="scene-toolcard-catalog" href={`/catalog?q=${encodeURIComponent(tool.model)}`} target="_blank" rel="noopener noreferrer">在 OEM 目录查看完整资料 ↗</a>
    </aside>
  );
}
