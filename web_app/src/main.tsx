import { Component, StrictMode, useEffect, useMemo, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient } from '@fab/api-client';
import type { CreateRunRequest, RunResult, RunSummary, SiteDto } from '@fab/contracts';
import { Panel, StatusPill } from '@fab/ui';
import { Metric } from '@fab/widgets';
import { CompletionBar } from '@fab/charting';
import { ScopeGate, startPolling } from '@fab/state-sync';
import { SceneFacade } from '@fab/fab-scene';
import { createWebGpuBackend } from '@fab/babylon-webgpu';
import { validateScenario } from './scenario';
import './styles.css';

const api = new ApiClient();
const message = (error: unknown) => error instanceof Error ? error.message : '未知错误';
const complete = (status: string) => status.toUpperCase() === 'COMPLETED';
const count = (value: string) => BigInt(value).toLocaleString('zh-CN');

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() { return this.state.error ? <div className="fatal"><h1>工作台无法显示数据</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>重新加载</button></div> : this.props.children; }
}

function SiteScene({ site }: { site: SiteDto }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('准备 WebGPU 视图…');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!canvas.current) return;
    const facade = new SceneFacade(createWebGpuBackend());
    void facade.mount(canvas.current, site.fabs.map((fab, index) => ({ fabId: fab.fabId, code: fab.code, position: [(index - (site.fabs.length - 1) / 2) * 46, 0, 0] })), setStatus);
    return () => facade.dispose();
  }, [site, generation]);
  return <div className="scene"><canvas ref={canvas} aria-label="FAB 基地估算占位几何"/><div className="scene-top"><span className="technical">SITE DIGITAL VIEW</span><span className="scene-tag">米 · 右手系 · +Y UP</span></div><div className="scene-caption"><span>{status}</span><button className="ghost" onClick={() => setGeneration(value => value + 1)}>重新加载视图 ↻</button></div></div>;
}

function Workbench({ site }: { site: SiteDto }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<RunSummary>();
  const [result, setResult] = useState<RunResult>();
  const [listError, setListError] = useState('');
  const [runError, setRunError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lotCount, setLotCount] = useState('24');
  const [processTimeUs, setProcessTimeUs] = useState('1000000');
  const [durationUs, setDurationUs] = useState('60000000');
  const [warmupUs, setWarmupUs] = useState('0');
  const [masterSeed, setMasterSeed] = useState('42');
  const submissionScope = useMemo(() => new ScopeGate(), []);
  const pendingSubmission = useRef<{ json: string; key: string } | undefined>(undefined);
  useEffect(() => () => submissionScope.dispose(), [submissionScope]);
  useEffect(() => startPolling(signal => api.runs(signal), values => {
    const scoped = values.filter(value => value.siteId === site.siteId);
    setRuns(scoped); setListError('');
    setRunId(previous => previous || scoped[0]?.runId || '');
  }, error => setListError(message(error))), [site.siteId]);
  useEffect(() => {
    setRun(undefined); setResult(undefined); setRunError('');
    if (!runId) return;
    return startPolling(async signal => {
      const current = await api.run(runId, signal);
      if (current.siteId !== site.siteId || current.runId !== runId) throw new Error('API 返回了错误作用域的 Run');
      const results = complete(current.status) ? await api.results(runId, signal) : undefined;
      if (results && results.runId !== runId) throw new Error('API 返回了错误作用域的结果');
      return { current, results };
    }, data => { setRun(data.current); setResult(data.results); setRunError(''); }, error => setRunError(message(error)));
  }, [runId, site.siteId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); setSubmitError('');
    const validationError = validateScenario({ lotCount, processTimeUs, durationUs, warmupUs, masterSeed });
    if (validationError) { setSubmitError(validationError); return; }
    const lots = Number(lotCount);
    const request: CreateRunRequest = { scenario: { contractVersion: 1, siteId: site.siteId, mode: 'INDEPENDENT', masterSeed, durationUs, warmupUs, fabs: site.fabs.map(fab => ({ fabId: fab.fabId, code: fab.code, lotCount: lots, processTimeUs })) } };
    const json = JSON.stringify(request);
    if (pendingSubmission.current?.json !== json) pendingSubmission.current = { json, key: crypto.randomUUID() };
    const token = submissionScope.begin(site.siteId);
    setSubmitting(true);
    try {
      const created = await api.createRun(request, pendingSubmission.current.key, token.signal);
      if (submissionScope.accepts(token)) {
        setRuns(previous => [created, ...previous.filter(value => value.runId !== created.runId)]);
        setRunId(created.runId); pendingSubmission.current = undefined;
      }
    } catch (error: unknown) { if (submissionScope.accepts(token)) setSubmitError(message(error)); }
    finally { if (submissionScope.accepts(token)) setSubmitting(false); }
  }

  const displayedRun = run?.runId === runId ? run : undefined;
  const displayedResult = result?.runId === runId ? result : undefined;
  const completedLots = displayedResult?.fabs.reduce((sum, fab) => sum + BigInt(fab.completedLots), 0n);
  return <>
    <div className="metrics"><Metric label="基地 FAB" value={site.fabs.length.toString().padStart(2, '0')} hint="来自 Site API · 独立执行域"/><Metric label="当前运行" value={displayedRun ? <StatusPill status={displayedRun.status}/> : '—'} hint={displayedRun ? `版本 ${displayedRun.version}` : '选择或创建一个 Run'}/><Metric label="完成 Lot" value={completedLots?.toLocaleString('zh-CN') ?? '—'} hint="仅展示后端已提交的完整结果"/><Metric label="运行模式" value="独立仿真" hint="INDEPENDENT · 合成 FIFO 模型"/></div>
    <div className="primary-grid"><Panel title="基地空间概览" subtitle="共享几何模板，独立 FAB 实例；非真实设备布局。"><SiteScene site={site}/><div className="scene-legend"><span><i/>估算加工设备</span><span>无实时设备连接</span><span>{site.code} / {site.fabs.length} FAB</span></div></Panel>
    <Panel title="新建仿真" subtitle="三个 FAB 使用相同模板，运行状态相互隔离。"><form onSubmit={event => { void submit(event); }}><div className="model-label">◇ 合成 FIFO · 单设备加工模型</div><div className="field-grid"><label>每 FAB Lot 数<input value={lotCount} onChange={event => setLotCount(event.target.value)} inputMode="numeric" required/></label><label>单 Lot 加工 / μs<input value={processTimeUs} onChange={event => setProcessTimeUs(event.target.value)} inputMode="numeric" required/></label><label>仿真时域 / μs<input value={durationUs} onChange={event => setDurationUs(event.target.value)} inputMode="numeric" required/></label><label>预热时长 / μs<input value={warmupUs} onChange={event => setWarmupUs(event.target.value)} inputMode="numeric" required/></label></div><label>主随机种子<input value={masterSeed} onChange={event => setMasterSeed(event.target.value)} inputMode="numeric" required/></label><p className="form-note">整数微秒 · 权威 DES 在后端执行<br/>不包含共享产能、跨 FAB 流转或真实工艺模型。</p>{submitError && <div className="error" role="alert">{submitError}</div>}<button className="primary" disabled={submitting || !site.fabs.length}>{submitting ? '正在提交…' : '创建并运行'}<span>↗</span></button></form></Panel></div>
    <div className="section-heading"><div><h2>FAB 执行概览</h2><p>HTTP 全量快照 · 每 1.5 秒查询 · 无二进制实时流</p></div><span className="technical">{displayedRun ? `RUN / ${displayedRun.runId.slice(0, 8)}` : 'AWAITING RUN'}</span></div>
    {runError && <div className="error" role="alert">运行查询失败：{runError}；下列已显示值可能过期。</div>}
    <div className="fab-grid">{site.fabs.map((fab, index) => {
      const execution = displayedRun?.executions.find(value => value.fabId === fab.fabId);
      const metrics = displayedResult?.fabs.find(value => value.fabId === fab.fabId);
      return <article className="fab-card" key={fab.fabId}><div className="fab-card-head"><span className="fab-icon">{String(index + 1).padStart(2, '0')}</span><div><h3>{fab.code}</h3><small>独立执行域</small></div>{execution ? <StatusPill status={execution.status}/> : <span className="muted">待选择 Run</span>}</div><div className="fab-values"><div><span>完成 / 总 Lot</span><strong>{execution ? `${count(execution.completedLots)} / ${count(execution.totalLots)}` : '—'}</strong></div><div><span>仿真时间 / μs</span><strong>{execution ? count(execution.simulationTimeUs) : '—'}</strong></div></div>{execution && <CompletionBar completed={execution.completedLots} total={execution.totalLots}/>}<div className="hash">{metrics ? `轨迹 SHA ${metrics.traceHash.slice(0, 18)}…` : '等待后端提交结果'}</div>{execution?.error && <div className="error">{execution.error}</div>}</article>;
    })}</div>
    <Panel title="运行记录" subtitle="站点范围内的持久化 Run；点击查看执行状态与完整结果。">{listError && <div className="error" role="alert">列表查询失败：{listError}</div>}<div className="table-scroll"><table><thead><tr><th>运行标识</th><th>创建时间</th><th>FAB 数</th><th>状态</th><th>操作</th></tr></thead><tbody>{runs.map(value => <tr key={value.runId} className={runId === value.runId ? 'selected' : ''}><td className="mono">{value.runId.slice(0, 8)}</td><td>{new Date(value.createdAtUtc).toLocaleString('zh-CN', { hour12: false })}</td><td>{value.executions.length}</td><td><StatusPill status={value.status}/></td><td><button className="text-button" onClick={() => setRunId(value.runId)}>{runId === value.runId ? '当前运行' : '查看运行'} →</button></td></tr>)}</tbody></table>{runs.length === 0 && <div className="empty">{listError ? '暂无可用运行数据' : '暂无运行记录。创建一次仿真，开始查看后端结果。'}</div>}</div></Panel>
  </>;
}

function App() {
  const [sites, setSites] = useState<SiteDto[]>([]);
  const [siteId, setSiteId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void api.sites(controller.signal).then(values => { if (!controller.signal.aborted) { setSites(values); setSiteId(previous => values.some(value => value.siteId === previous) ? previous : values[0]?.siteId ?? ''); } }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(message(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const site = sites.find(value => value.siteId === siteId);
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/" aria-label="SemiconFab 工作台"><span className="brand-mark">F</span><span>SEMICON<span className="brand-accent">FAB</span><small>SIMULATION WORKSPACE</small></span></a><div className="nav-label">工作空间</div><a className="nav-link active" href="#overview"><span>▦</span>基地总览<span className="nav-dot"/></a><a className="nav-link" href="#runs"><span>▷</span>仿真运行</a><div className="sidebar-note"><span className="technical">DEVELOPMENT SLICE</span><p>确定性离散事件仿真<br/>独立 FAB · 本地开发模式</p><span className="development-badge">开发环境</span></div></aside><main id="overview"><header className="topbar"><span>工作空间 <b>/</b> 基地总览</span><span className="topbar-right"><i/> REST / HTTP 轮询 <span className="avatar">DEV</span></span></header><div className="content"><div className="page-heading"><div><div className="eyebrow">OPERATIONS OVERVIEW</div><h1>基地仿真工作台<span> / 01</span></h1><p>从场景参数到执行结果，让每一次仿真清晰可追溯。</p></div><label className="site-picker">当前基地<select value={siteId} onChange={event => setSiteId(event.target.value)} disabled={!sites.length}>{!sites.length && <option>等待 API 数据</option>}{sites.map(value => <option key={value.siteId} value={value.siteId}>{value.code}</option>)}</select></label></div><div className="info-banner"><span>ⓘ</span><p><strong>开发切片</strong> 合成 FIFO 加工模型 · 数据来自本地 API / Worker · 3D 为估算占位几何。</p><span className="technical">v0.1</span></div>{error && <div className="error" role="alert">站点 API 错误：{error}。请检查 API、Worker 与服务器端开发密钥配置。<button className="ghost" onClick={() => setReload(value => value + 1)}>重试</button></div>}{loading && <div className="empty">正在读取站点…</div>}{!loading && !error && !site && <div className="empty">API 未返回可用站点。</div>}<div id="runs">{site && <Workbench site={site} key={site.siteId}/>}</div><footer>SEMICONFAB NEXT <span>后端权威仿真 · WebGPU 视图 · 明确的模型边界</span></footer></div></main></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App/></ErrorBoundary></StrictMode>);
