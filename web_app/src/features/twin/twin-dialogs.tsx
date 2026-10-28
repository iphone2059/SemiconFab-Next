import { useMemo } from 'react';
import { useTwinLocale } from './twin-i18n';
import { ORIGINAL_TWIN_UI, filterOriginalOem, type OriginalOem } from '../../original-twin-data';
import { useTwinPageStore, twinPageActions } from '../../state/twinPageStore';
import { Modal, ModalTitle } from '../../components/modal';
import { classNames } from '../../class-names';

const ARCH_LAYERS = [
  {
    level: 'LEVEL 1 / 2', meta: 'SEMI Standards', color: 'amber',
    title: 'Equipment Connectivity & Telemetry',
    body: 'SECS-I/II, GEM, GEM300 and OPC UA protocols for direct tool chamber telemetry.',
    tools: [['secsgem (Python)', 'SEMI E4/E5/E30'], ['open62541 (C)', 'OPC UA Client/Server'], ['Eclipse Milo (Java)', 'Industrial Gateway']],
    replaces: 'Applied SmartFactory Edge, Telit deviceWISE',
  },
  {
    level: 'LEVEL 3', meta: 'MES & Logistics', color: 'indigo',
    title: 'Manufacturing Execution (MES)',
    body: 'Lot & wafer tracking, FOUP AMHS dispatching, recipe management and track-in/out.',
    tools: [['OpenMES / ERPNext', 'ISA-95 Work Orders'], ['Google OR-Tools', 'Fab Dispatching'], ['SimPy / salabim', 'Discrete-Event Sim']],
    replaces: 'Siemens Opcenter Execution, Camstar, Critical Mfg',
  },
  {
    level: 'LEVEL 3 / APC', meta: 'Process Quality', color: 'emerald',
    title: 'Process Control (SPC & FDC)',
    body: 'Shewhart control charts, Nelson run rules, Cpk capability and chamber fault detection.',
    tools: [['pyspc / mfgQC', 'Shewhart & Nelson'], ['spc-kit (PostgreSQL)', 'In-Database SPC'], ['PyOD / tsfresh', 'FDC Sensor Anomaly']],
    replaces: 'KLA SPC, Applied SmartFactory FDC, Q-DAS',
  },
  {
    level: 'LEVEL 4', meta: 'Yield Engineering', color: 'sky',
    title: 'Yield Management (YMS)',
    body: 'Wafer probe bin maps, STDF datalog parsing, spatial defect classification and Poisson yield.',
    tools: [['PySTDF / rust-stdf', 'ATE STDF V4 Parser'], ['wafermap / uia-map', 'Wafer Bin Renderer'], ['WM-811K Classifier', 'AI Spatial Defects']],
    replaces: 'KLA Klarity, PDF Solutions Exensio, Siemens YieldExplorer',
  },
];
const DATA_ROWS = [
  ['Event Streaming', 'TIBCO Rendezvous / Solace', 'Apache Kafka / Eclipse Mosquitto', 'Sub-second ingestion of SECS/GEM S6F11 events and chamber sensor telemetry'],
  ['Time-Series DB', 'OSIsoft PI / Aspen InfoPlus.21', 'TimescaleDB / InfluxDB', 'High-frequency RF power, MFC gas flows, chuck temperatures and pressure curves'],
  ['OLAP & Wafer Analytics', 'Snowflake / Oracle Exadata', 'ClickHouse / DuckDB', 'Instant query across billions of parametric wafer test points and multi-lot correlations'],
  ['Visualization & Dashboards', 'Siemens Opcenter Intelligence', 'Grafana / Apache Superset', 'Live fab OEE, chamber SOH, Shewhart SPC control charts and yield waterfall monitoring'],
];

export function TwinInfoDialog({ mode, onClose, onSelectOem }: { mode: 'architecture' | 'database'; onClose: () => void; onSelectOem: (id: string) => void }) {
  const { t, language } = useTwinLocale();
  const zh = language === 'zh';
  const oemDialog = useTwinPageStore((state) => state.oemDialog);
  const archQuery = useTwinPageStore((state) => state.archQuery);
  const allOem = ORIGINAL_TWIN_UI.oem;
  const segments = useMemo(() => [...new Set(allOem.map((row) => row.segment))], [allOem]);
  const vendors = useMemo(() => [...new Set(allOem.map((row) => row.vendor))].sort(), [allOem]);
  const oemRows = useMemo(() => filterOriginalOem(oemDialog.query, oemDialog.segment)
    .filter((row) => oemDialog.vendor === 'ALL' || row.vendor === oemDialog.vendor), [oemDialog]);
  const archText = ARCH_LAYERS.map((row) => `${row.title} ${row.body} ${row.tools.flat().join(' ')}`).join(' ')
    + DATA_ROWS.flat().join(' ');
  const showArch = !archQuery.trim() || archText.toLowerCase().includes(archQuery.trim().toLowerCase());
  async function copyRecord(row: OriginalOem): Promise<void> {
    try { await navigator.clipboard?.writeText(JSON.stringify(row, null, 2)); } catch { /* clipboard may be blocked */ }
  }
  return (
    <Modal id={mode === 'database' ? 'oem-database-modal' : 'open-architecture-modal'} backdropClassName="twin-yms-backdrop"
      className="twin-yms twin-dialog-wide" label={mode === 'database' ? t('OEM 数据库') : t('开放软件架构')}
      onClose={onClose}>
        <header className="twin-yms-head">
          <div>
            <ModalTitle asChild><strong>{mode === 'database' ? 'GLOBAL SEMICONDUCTOR EQUIPMENT DATABASE (BETA)' : 'OPEN SEMICONDUCTOR SOFTWARE ARCHITECTURE & STANDARDS'}</strong></ModalTitle>
            <span>{mode === 'database' ? '116 Verified OEM Models · SEMI-E72 physical data' : 'ISA-95 Level 1-4 · SEMI Protocols'}</span>
          </div>
          <button type="button" className="twin-yms-close" onClick={onClose} autoFocus aria-label={t('关闭')}>×</button>
        </header>
        {mode === 'database' ? <>
          <div className="twin-dialog-filterbar">
            <input id="modal-search-input" type="search" value={oemDialog.query} onChange={(event) => twinPageActions.oemDialogQuerySet(event.target.value)} placeholder={t('搜索型号、厂商、规格或工艺节点…')} aria-label={t('搜索 OEM 数据库')} />
            <select id="modal-segment-select" value={oemDialog.segment} onChange={(event) => twinPageActions.oemDialogSegmentSet(event.target.value)} aria-label={t('工艺段')}>
              <option value="ALL">{t('全部工艺段')} ({segments.length})</option>
              {segments.map((segment) => <option key={segment} value={segment}>{segment}</option>)}
            </select>
            <select id="modal-vendor-select" value={oemDialog.vendor} onChange={(event) => twinPageActions.oemDialogVendorSet(event.target.value)} aria-label={t('厂商')}>
              <option value="ALL">{t('全部厂商')} ({vendors.length})</option>
              {vendors.map((vendor) => <option key={vendor} value={vendor}>{vendor}</option>)}
            </select>
            <span className="twin-dialog-count">Showing <b id="modal-matched-count">{oemRows.length}</b> of {allOem.length} records</span>
          </div>
          <div className="twin-dialog-tablewrap">
            <table className="twin-dialog-table">
              <thead><tr><th>Segment</th><th>Vendor</th><th>Model</th><th>Process Node</th><th>Wafer</th><th>Dimensions (W×D×H)</th><th>Weight</th><th>Key Specifications</th><th className="right">Action</th></tr></thead>
              <tbody id="modal-database-tbody">
                {oemRows.map((row) => <tr key={row.id}>
                  <td><span className="twin-dialog-seg">{row.segment}</span></td><td>{row.vendor}</td><td><b>{row.model}</b></td>
                  <td>{row.process_node || 'General Node'}</td><td>{row.wafer_size}</td><td className="mono">{row.dimensions}</td><td className="mono">{row.weight}</td>
                  <td className="spec">{row.key_specs}</td>
                  <td className="right"><button type="button" className="twin-dialog-action" onClick={() => { onClose(); onSelectOem(row.id); }}>{t('查看')} ↗</button><button type="button" className="twin-dialog-copy" onClick={() => void copyRecord(row)} aria-label={t('复制记录')}>⧉</button></td>
                </tr>)}
              </tbody>
            </table>
            {oemRows.length === 0 && <p className="twin-dialog-empty">{t('没有匹配的 OEM 记录')}</p>}
          </div>
        </> : <>
          <div className="twin-dialog-filterbar">
            <input id="arch-search-input" type="search" value={archQuery} onChange={(event) => twinPageActions.archQuerySet(event.target.value)} placeholder={t('搜索开源工具 (secsgem, pyspc, PySTDF, SimPy, ClickHouse)…')} aria-label={t('搜索架构')} />
            <span className="twin-dialog-sources">Sources: <b>Awesome-Semiconductor-MES</b><b>Process-Control</b><b>Yield-Management</b></span>
          </div>
          <div className="twin-dialog-arch" id="arch-cards-container">
            {showArch && ARCH_LAYERS.map((layer) => <article className={classNames('twin-arch-card', layer.color)} key={layer.title}>
              <div className="twin-arch-meta"><span>{layer.level}</span><small>{layer.meta}</small></div>
              <h3>{layer.title}</h3><p>{layer.body}</p>
              <div className="twin-arch-tools">{layer.tools.map(([tool, tag]) => <div key={tool}><b>{tool}</b><span>{tag}</span></div>)}</div>
              <footer>Replaces: {layer.replaces}</footer>
            </article>)}
            {showArch && <div className="twin-arch-tablewrap"><h3>Industrial High-Throughput Data Infrastructure for 300mm Smart Fabs</h3>
              <table className="twin-dialog-table"><thead><tr><th>Role</th><th>Commercial Benchmark</th><th>Recommended Open-Source Stack</th><th>Semiconductor Fab Functionality</th></tr></thead>
                <tbody>{DATA_ROWS.map(([role, commercial, stack, usage]) => <tr key={role}><td><b>{role}</b></td><td>{commercial}</td><td className="stack">{stack}</td><td>{usage}</td></tr>)}</tbody>
              </table>
            </div>}
            {!showArch && <p className="twin-dialog-empty">{t('没有匹配的架构条目')}</p>}
          </div>
          <footer className="twin-dialog-foot">{zh ? '参考架构；不包含生产级部署配置。' : 'Reference architecture only; production deployment configuration is out of scope.'}</footer>
        </>}
    </Modal>
  );
}
