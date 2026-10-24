import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import { ApiClient } from './api-client';
import type { CatalogEntryDto } from './contracts';
import {
  catalogFields,
  filterCatalog,
  parseCatalogEntries,
  readCatalogRoute,
  safeExternalUrl,
  type CatalogDomain,
  type CatalogField,
} from './catalog-data';
import { readPreferences, type Preferences } from './preferences';
import '../assets/catalog.css';
import legacyLicenseUrl from '../assets/legacy-LICENSE.txt?url';

type Language = Preferences['language'];
const text = (language: Language, zh: string, en: string) => (language === 'zh' ? zh : en);
const api = new ApiClient();
const pageSize = 40;
const valueText = (value: unknown) =>
  value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
const categoryNames: Readonly<Record<string, readonly [string, string]>> = {
  lithography: ['光刻', 'Lithography'],
  resist_track: ['涂胶显影', 'Resist track'],
  dry_etch: ['干法刻蚀', 'Dry etch'],
  wet_clean: ['湿法清洗', 'Wet clean'],
  thin_film_deposition: ['薄膜沉积', 'Thin film deposition'],
  cmp: ['化学机械抛光', 'CMP'],
  thermal_processing: ['热处理', 'Thermal processing'],
  ion_implantation: ['离子注入', 'Ion implantation'],
  metrology: ['量测', 'Metrology'],
  inspection: ['检测', 'Inspection'],
  test: ['测试', 'Test'],
  packaging: ['封装', 'Packaging'],
  other: ['其他', 'Other'],
  osat_dicing: ['OSAT 划片', 'OSAT dicing'],
  osat_die_attach: ['OSAT 固晶', 'OSAT die attach'],
  osat_wire_bonding: ['OSAT 引线键合', 'OSAT wire bonding'],
  osat_flip_chip: ['OSAT 倒装', 'OSAT flip chip'],
  osat_molding: ['OSAT 塑封', 'OSAT molding'],
  osat_singulation: ['OSAT 分割', 'OSAT singulation'],
  osat_bumping_rdl: ['OSAT 凸点 / RDL', 'OSAT bumping / RDL'],
  osat_prober: ['OSAT 探针台', 'OSAT prober'],
  osat_ate: ['OSAT 自动测试', 'OSAT ATE'],
  osat_test_handler: ['OSAT 测试分选', 'OSAT test handler'],
  osat_inspection: ['OSAT 检测', 'OSAT inspection'],
};
const categoryText = (category: string, language: Language) =>
  categoryNames[category]?.[language === 'zh' ? 0 : 1] ?? category;

function Price({ entry, language }: { entry: CatalogEntryDto; language: Language }) {
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

function FieldValue({ field }: { field: CatalogField | undefined }) {
  if (!field) return <>—</>;
  const href = safeExternalUrl(field.source);
  return (
    <>
      <span>
        {valueText(field.value)}
        {field.unit && ` ${field.unit}`}
      </span>
      {field.tier && <small>{field.tier}</small>}
      {field.source && (
        <small>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {field.source} ↗
            </a>
          ) : (
            field.source
          )}
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

export function CatalogComparison({
  entries,
  language,
  onRemove,
}: {
  entries: readonly CatalogEntryDto[];
  language: Language;
  onRemove: (id: string) => void;
}) {
  const fields = useMemo(
    () =>
      entries.map(
        (entry) => new Map(catalogFields(entry.record).map((field) => [field.path, field])),
      ),
    [entries],
  );
  const paths = useMemo(
    () => [...new Set(fields.flatMap((map) => [...map.keys()]))].sort(),
    [fields],
  );
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

function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EquipmentDetails({
  entry,
  language,
  onClose,
}: {
  entry: CatalogEntryDto;
  language: Language;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="catalog-dialog"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="equipment-title"
    >
      <div className="catalog-dialog-head">
        <div>
          <span className="catalog-eyebrow">{entry.vendor}</span>
          <h2 id="equipment-title">{entry.model}</h2>
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
        <button onClick={() => downloadJson(entry.record, `${entry.recordId}.json`)}>
          {text(language, '下载设备记录 JSON', 'Download equipment record JSON')}
        </button>
      </div>
    </dialog>
  );
}

function initialPreferences(): Preferences {
  try {
    return readPreferences(localStorage, location.search);
  } catch {
    return readPreferences({ getItem: () => null }, location.search);
  }
}

export function CatalogPage({ view: initialView }: { view: 'catalog' | 'compare' }) {
  const [view, setView] = useState(initialView);
  const [initial] = useState(() => readCatalogRoute(new URL(location.href)));
  const [preferences, setPreferences] = useState(initialPreferences);
  const language = preferences.language;
  const t = (zh: string, en: string) => text(language, zh, en);
  const [entries, setEntries] = useState<readonly CatalogEntryDto[]>([]);
  const [importId, setImportId] = useState('');
  const [domain, setDomain] = useState<CatalogDomain>(initial.domain);
  const [category, setCategory] = useState(initial.category);
  const [query, setQuery] = useState(initial.query);
  const [hideDrafts, setHideDrafts] = useState(initial.hideDrafts);
  const [selected, setSelected] = useState<readonly string[]>(initial.compare);
  const [detail, setDetail] = useState<CatalogEntryDto>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [localPreview, setLocalPreview] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () => filterCatalog(entries, domain, category, deferredQuery, hideDrafts),
    [entries, domain, category, deferredQuery, hideDrafts],
  );
  const categories = useMemo(
    () =>
      [
        ...new Set(
          entries
            .filter((entry) => domain === 'ALL' || entry.domain === domain)
            .map((entry) => entry.category),
        ),
      ].sort(),
    [entries, domain],
  );
  const selectedEntries = useMemo(
    () =>
      selected.flatMap((id) => {
        const entry = entries.find((item) => item.recordId === id);
        return entry ? [entry] : [];
      }),
    [selected, entries],
  );
  const missingIds = selected.filter((id) => !entries.some((entry) => entry.recordId === id));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    void api
      .catalog({}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || current !== generation.current) return;
        const parsed = parseCatalogEntries({ entries: data.items });
        setEntries(parsed);
        setImportId(data.importId);
        setLocalPreview(false);
        setDetail(undefined);
        if (
          readCatalogRoute(new URL(location.href)).view === 'compare' &&
          !new URL(location.href).searchParams.has('compare')
        )
          setSelected(
            parsed
              .filter((entry) => entry.category === 'lithography')
              .slice(0, 3)
              .map((entry) => entry.recordId),
          );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && current === generation.current)
          setError(reason instanceof Error ? reason.message : 'Catalog request failed');
      })
      .finally(() => {
        if (!controller.signal.aborted && current === generation.current) setLoading(false);
      });
    return () => {
      ++generation.current;
      controller.abort();
    };
  }, [reload]);

  useEffect(() => {
    const restore = () => {
      const route = readCatalogRoute(new URL(location.href));
      if (route.view === 'workbench' || route.view === 'twin') {
        location.reload();
        return;
      }
      setView(route.view);
      setDomain(route.domain);
      setCategory(route.category);
      setQuery(route.query);
      setHideDrafts(route.hideDrafts);
      setSelected(route.compare);
      setPage(0);
      setPreferences(initialPreferences());
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = `${t(view === 'compare' ? '设备对比' : '设备目录', view === 'compare' ? 'Equipment comparison' : 'Equipment catalog')} · SemiconFab Next`;
    try {
      localStorage.setItem('semiconfab_lang', language);
      localStorage.setItem('semicon_lang', language);
      localStorage.setItem('semicon_theme', preferences.theme);
    } catch {
      /* Storage may be unavailable. */
    }
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      domain: domain === 'ALL' ? '' : domain.toLowerCase(),
      category,
      q: query,
      hideDrafts: hideDrafts ? '1' : '',
      compare: selected.join(','),
      lang: language,
      theme: preferences.theme,
    }))
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    history.replaceState(null, '', url);
  }, [language, preferences.theme, view, domain, category, query, selected, hideDrafts]);

  function toggle(id: string): void {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : previous.length < 4
          ? [...previous, id]
          : previous,
    );
  }
  function openView(next: 'catalog' | 'compare'): void {
    const url = new URL(location.href);
    url.pathname = next === 'compare' ? '/compare' : '/catalog';
    url.searchParams.set('compare', selected.join(','));
    if (location.pathname !== url.pathname) history.pushState(null, '', url);
    setView(next);
  }
  function navigate(event: MouseEvent<HTMLAnchorElement>, next: 'catalog' | 'compare'): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    openView(next);
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(t('文件超过 10 MiB。', 'File exceeds 10 MiB.'));
      return;
    }
    const current = ++generation.current;
    request.current?.abort();
    setLoading(false);
    try {
      const parsed = parseCatalogEntries(JSON.parse(await file.text()));
      if (current !== generation.current) return;
      setEntries(parsed);
      setImportId(file.name);
      setLocalPreview(true);
      setDetail(undefined);
      setError('');
      setPage(0);
    } catch (reason: unknown) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : t('导入失败', 'Import failed'));
    }
  }

  return (
    <div className="catalog-shell" data-theme={preferences.theme}>
      <header className="catalog-header">
        <a className="catalog-brand" href="/">
          SEMICON<span>FAB</span>
          <small>NEXT</small>
        </a>
        <nav aria-label={t('主导航', 'Main navigation')}>
          <a href="/">{t('基地工作台', 'Workbench')}</a>
          <a
            className={view === 'catalog' ? 'active' : ''}
            href={`/catalog?lang=${language}`}
            onClick={(event) => navigate(event, 'catalog')}
          >
            {t('设备目录', 'Catalog')}
          </a>
          <a
            className={view === 'compare' ? 'active' : ''}
            href={`/compare?compare=${selected.join(',')}&lang=${language}`}
            onClick={(event) => navigate(event, 'compare')}
          >
            {t('设备对比', 'Compare')}
          </a>
        </nav>
        <div className="catalog-preferences">
          <button
            onClick={() =>
              setPreferences((value) => ({
                ...value,
                language: value.language === 'zh' ? 'en' : 'zh',
              }))
            }
          >
            {language === 'zh' ? 'EN' : '中文'}
          </button>
          <button
            aria-label={t('切换主题', 'Toggle theme')}
            onClick={() =>
              setPreferences((value) => ({
                ...value,
                theme: value.theme === 'light' ? 'dark' : 'light',
              }))
            }
          >
            {preferences.theme === 'light' ? '◐' : '☀'}
          </button>
        </div>
      </header>
      <main className="catalog-main">
        <div className="catalog-heading">
          <div>
            <span className="catalog-eyebrow">EQUIPMENT INTELLIGENCE</span>
            <h1>
              {view === 'compare'
                ? t('让设备差异，清晰可见。', 'See how the tools compare.')
                : t('从设备开始，理解晶圆工厂。', 'Understand the fab, one tool at a time.')}
            </h1>
            <p>
              {t(
                '前道制造与封装测试设备 · 原始规格、字段来源与估算依据',
                'Front-end & OSAT equipment · Original specifications, provenance and estimates',
              )}
            </p>
          </div>
          <span className="catalog-total">
            <strong>{entries.length}</strong>
            {t('条设备记录', 'equipment records')}
          </span>
        </div>
        <div className="catalog-notice">
          {localPreview
            ? t(
                '本地预览：仅替换此页面显示，不会上传、批准或修改基地设备。',
                'Local preview: this page only. No upload, approval or Site equipment changes. Export JSON to share local data.',
              )
            : t(
                '迁移自原版设备库。L1 / draft 为历史标签；估价为带日期的参考区间。',
                'Migrated from the original catalog. L1 / draft are legacy labels; estimates are dated reference ranges.',
              )}
        </div>
        {error && (
          <div className="catalog-error" role="alert">
            {error}{' '}
            <button onClick={() => setReload((value) => value + 1)}>
              {t('重新读取服务端目录', 'Reload server catalog')}
            </button>
          </div>
        )}
        {view === 'compare' && (
          <section className="catalog-section" aria-label={t('设备对比结果', 'Comparison results')}>
            <CatalogComparison entries={selectedEntries} language={language} onRemove={toggle} />
            {!loading &&
              missingIds.map((id) => (
                <p className="catalog-error" key={id}>
                  {t('目录中未找到：', 'Not found in catalog: ')}
                  {id} <button onClick={() => toggle(id)}>{t('移除', 'Remove')}</button>
                </p>
              ))}
          </section>
        )}
        <section className="catalog-section">
          <div className="catalog-toolbar">
            <div className="catalog-domains" aria-label={t('设备领域', 'Equipment domain')}>
              {(['ALL', 'FAB', 'OSAT'] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={domain === value}
                  onClick={() => {
                    setDomain(value);
                    setCategory('');
                    setPage(0);
                  }}
                >
                  {value === 'ALL' ? t('全部设备', 'All equipment') : value}
                </button>
              ))}
            </div>
            <label className="catalog-file">
              {t('载入本地 JSON', 'Load local JSON')}
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  void importFile(event);
                }}
              />
            </label>
            <button
              disabled={!entries.length}
              onClick={() =>
                downloadJson(
                  {
                    contractVersion: 1,
                    importId,
                    source: localPreview ? 'LOCAL_PREVIEW' : 'SemiconFab-main',
                    entries,
                  },
                  'semiconfab-catalog.json',
                )
              }
            >
              {t('导出目录', 'Export catalog')}
            </button>
            {localPreview && (
              <button onClick={() => setReload((value) => value + 1)}>
                {t('恢复服务端目录', 'Restore server catalog')}
              </button>
            )}
          </div>
          <div className="catalog-filters">
            <label>
              {t('搜索设备', 'Search equipment')}
              <input
                type="search"
                value={query}
                maxLength={200}
                placeholder={t('厂商、型号或分类…', 'Vendor, model or category…')}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              {t('设备分类', 'Category')}
              <select
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">{t('所有分类', 'All categories')}</option>
                {category && !categories.includes(category) && (
                  <option value={category}>{category}</option>
                )}
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {categoryText(value, language)}
                  </option>
                ))}
              </select>
            </label>
            <label className="catalog-hide-drafts">
              <input
                type="checkbox"
                checked={hideDrafts}
                onChange={(event) => {
                  setHideDrafts(event.target.checked);
                  setPage(0);
                }}
              />
              {t('隐藏 draft 记录', 'Hide draft records')}
            </label>
            <button disabled={selected.length === 0} onClick={() => openView('compare')}>
              {t(`对比已选 ${selected.length} / 4`, `Compare ${selected.length} / 4`)}
            </button>
          </div>
          <div className="catalog-result-heading">
            <span aria-live="polite">
              {loading
                ? t('正在读取目录…', 'Loading catalog…')
                : t(`找到 ${filtered.length} 条设备`, `${filtered.length} tools found`)}
            </span>
            <span className="catalog-muted">
              {localPreview ? 'LOCAL PREVIEW' : importId ? `SNAPSHOT ${importId.slice(0, 12)}` : ''}
            </span>
          </div>
          <div className="catalog-table-scroll">
            <table className="catalog-list">
              <thead>
                <tr>
                  <th>{t('对比', 'Compare')}</th>
                  <th>{t('设备型号', 'Equipment')}</th>
                  <th>{t('分类', 'Category')}</th>
                  <th>{t('原版等级 / 完整度', 'Legacy level / completeness')}</th>
                  <th>{t('估算价格 / USD', 'Estimated price / USD')}</th>
                  <th>{t('详情', 'Details')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                  .map((entry) => (
                    <tr key={entry.recordId}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t(`对比 ${entry.model}`, `Compare ${entry.model}`)}
                          checked={selected.includes(entry.recordId)}
                          disabled={selected.length >= 4 && !selected.includes(entry.recordId)}
                          onChange={() => toggle(entry.recordId)}
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
                          {t(
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
                          onClick={() => setDetail(entry)}
                          aria-label={t(`查看 ${entry.model}`, `Inspect ${entry.model}`)}
                        >
                          {t('查看规格', 'Inspect')} ↗
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!loading && filtered.length === 0 && (
            <p className="catalog-empty">
              {error
                ? t(
                    '暂无可用目录，请重试或载入本地 JSON。',
                    'Catalog unavailable. Retry or load local JSON.',
                  )
                : t('没有匹配设备，请调整筛选条件。', 'No matching tools. Adjust the filters.')}
            </p>
          )}
          <div className="catalog-pagination">
            <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              {t('上一页', 'Previous')}
            </button>
            <span>
              {currentPage + 1} / {pageCount}
            </span>
            <button
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              {t('下一页', 'Next')}
            </button>
          </div>
        </section>
        <footer className="catalog-footer">
          <span>
            SEMICONFAB NEXT ·{' '}
            <a href={legacyLicenseUrl} target="_blank" rel="noopener noreferrer">
              {t('数据许可', 'Data license')}
            </a>
          </span>
          <span>
            {t(
              '原始数据与来源保留 · 型号目录独立于运行状态',
              'Original data & provenance preserved · Catalog independent of Run state',
            )}
          </span>
        </footer>
      </main>
      {detail && (
        <EquipmentDetails entry={detail} language={language} onClose={() => setDetail(undefined)} />
      )}
    </div>
  );
}
