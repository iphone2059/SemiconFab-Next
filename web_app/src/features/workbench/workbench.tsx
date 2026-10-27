import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRunRequest, SiteDto } from '../../contracts';
import { Panel, StatusPill } from '../../components/ui';
import { Metric } from '../../components/widgets';
import { CompletionBar } from '../../components/charting';
import { ScopeGate } from '../../state-sync';
import { validateScenario } from '../../scenario';
import { runQueryOptions, runResultsQueryOptions, runsQueryOptions } from '../../api/queries/runs.queries';
import { createRun, invalidateRuns } from '../../api/mutations/runs.mutations';
import { sitesQueryOptions } from '../../api/queries/sites.queries';
import { fab3dPath } from '../../app/router/url-mapping';
import { useWorkbenchStore, workbenchActions } from '../../state/workbenchStore';
import { useFabRuntimeRegistry } from '../../app/providers/RuntimeProvider';
import { CommandConsole } from './command-console';
const message = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { status?: unknown; data?: unknown; error?: unknown };
    if (value.data && typeof value.data === 'object') {
      const detail = (value.data as { detail?: unknown; title?: unknown }).detail ?? (value.data as { title?: unknown }).title;
      if (typeof detail === 'string') return detail;
    }
    if (typeof value.data === 'string') return value.data.slice(0, 180);
    if (typeof value.error === 'string') return value.error;
    if (value.status !== undefined) return `HTTP ${String(value.status)}`;
  }
  return '未知错误';
};
const complete = (status: string) => status.toUpperCase() === 'COMPLETED';
const count = (value: string) => BigInt(value).toLocaleString('zh-CN');

function Workbench({ site }: { site: SiteDto }) {
  const { runId, form, submitError } = useWorkbenchStore();
  const { lotCount, processTimeUs, durationUs, warmupUs, masterSeed } = form;
  const submissionScope = useMemo(() => new ScopeGate(), []);
  const queryClient = useQueryClient();
  const runsQuery = useQuery({ ...runsQueryOptions(), refetchInterval: 1500 });
  const scopedRuns = useMemo(() => (runsQuery.data ?? []).filter((value) => value.siteId === site.siteId), [runsQuery.data, site.siteId]);
  const runs = scopedRuns;
  const listError = runsQuery.error ? message(runsQuery.error) : '';
  const runQuery = useQuery({ ...runQueryOptions(runId), enabled: !!runId, refetchInterval: 1500 });
  const runCompleted = !!runQuery.data && complete(runQuery.data.status);
  // Results are only requested once the backend reports COMPLETED, exactly like the skipped RTK query.
  const resultQuery = useQuery({ ...runResultsQueryOptions(runId), enabled: !!runId && runCompleted });
  const run = runQuery.data;
  const result = resultQuery.data;
  const runError = runQuery.error ? message(runQuery.error) : resultQuery.error ? message(resultQuery.error) : '';
  const createRunMutation = useMutation({
    mutationFn: createRun,
    // The RTK mutation invalidated the Runs tag on success; keep that refresh for list/detail/results.
    onSuccess: () => {
      void invalidateRuns(queryClient);
    },
  });
  const submitting = createRunMutation.isPending;
  useEffect(() => () => submissionScope.dispose(), [submissionScope]);
  useEffect(() => {
    workbenchActions.runsReceived({ siteId: site.siteId, runIds: scopedRuns.map((value) => value.runId) });
  }, [scopedRuns, site.siteId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    workbenchActions.submitErrorSet('');
    if (site.fabs.length === 0) {
      workbenchActions.submitErrorSet('当前站点没有可用的 FAB');
      return;
    }
    const validationError = validateScenario({ lotCount, processTimeUs, durationUs, warmupUs, masterSeed });
    if (validationError) {
      workbenchActions.submitErrorSet(validationError);
      return;
    }
    const request: CreateRunRequest = {
      scenario: {
        contractVersion: 1, siteId: site.siteId, mode: 'INDEPENDENT', masterSeed, durationUs, warmupUs,
        // One execution per site FAB; the catalog is data-driven, never a fixed count.
        fabs: site.fabs.map((member) => ({ fabId: member.fabId, code: member.code, lotCount: Number(lotCount), processTimeUs })),
      },
    };
    const json = JSON.stringify(request);
    workbenchActions.submissionPrepared({ json, key: crypto.randomUUID() });
    const key = useWorkbenchStore.getState().pendingSubmission!.key;
    const token = submissionScope.begin(site.siteId);
    try {
      const created = await createRunMutation.mutateAsync({ request, idempotencyKey: key });
      if (submissionScope.accepts(token)) {
        workbenchActions.submissionCompleted({ siteId: site.siteId, key, runId: created.runId });
      }
    } catch (error: unknown) {
      if (submissionScope.accepts(token)) workbenchActions.submitErrorSet(message(error));
    }
  }


  const setField = (field: 'lotCount' | 'processTimeUs' | 'durationUs' | 'warmupUs' | 'masterSeed', value: string) => workbenchActions.formFieldSet({ field, value });
  const displayedRun = run?.runId === runId && run.siteId === site.siteId ? run : undefined;
  const displayedResult = displayedRun && result?.runId === runId ? result : undefined;
  const completedLots = displayedResult?.fabs.reduce(
    (sum, resultFab) => sum + BigInt(resultFab.completedLots),
    0n,
  );
  const executionFor = (fabId: string) => displayedRun?.executions.find((value) => value.fabId === fabId);
  const metricsFor = (fabId: string) => displayedResult?.fabs.find((value) => value.fabId === fabId);
  return (
    <>
      <div className="metrics">
        <Metric
          label="FAB"
          value={String(site.fabs.length).padStart(2, '0')}
          hint={`${site.fabs.map((member) => member.code).join(' · ')} · 独立执行域`}
        />
        <Metric
          label="当前运行"
          value={displayedRun ? <StatusPill status={displayedRun.status} /> : '—'}
          hint={displayedRun ? `版本 ${displayedRun.version}` : '选择或创建一个 Run'}
        />
        <Metric
          label="完成 Lot"
          value={completedLots?.toLocaleString('zh-CN') ?? '—'}
          hint="仅展示后端已提交的完整结果"
        />
        <Metric label="运行模式" value="独立仿真" hint="INDEPENDENT · 合成 FIFO 模型" />
      </div>
      <div className="workbench-run-form">
        <Panel title="新建仿真" subtitle={`${site.fabs.length} 个 FAB · 独立执行域。`}>
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <div className="model-label">◇ 合成 FIFO · 单设备加工模型</div>
            <div className="field-grid">
              <label>
                Lot 数
                <input
                  value={lotCount}
                  onChange={(event) => setField('lotCount', event.target.value)}
                  inputMode="numeric"
                  required
                />
              </label>
              <label>
                单 Lot 加工 / μs
                <input
                  value={processTimeUs}
                  onChange={(event) => setField('processTimeUs', event.target.value)}
                  inputMode="numeric"
                  required
                />
              </label>
              <label>
                仿真时域 / μs
                <input
                  value={durationUs}
                  onChange={(event) => setField('durationUs', event.target.value)}
                  inputMode="numeric"
                  required
                />
              </label>
              <label>
                预热时长 / μs
                <input
                  value={warmupUs}
                  onChange={(event) => setField('warmupUs', event.target.value)}
                  inputMode="numeric"
                  required
                />
              </label>
            </div>
            <label>
              主随机种子
              <input
                value={masterSeed}
                onChange={(event) => setField('masterSeed', event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <p className="form-note">
              整数微秒 · 权威 DES 在后端执行
              <br />
              不包含共享产能或真实工艺模型。
            </p>
            {submitError && (
              <div className="error" role="alert">
                {submitError}
              </div>
            )}
            <button className="primary" disabled={submitting || site.fabs.length === 0}>
              {submitting ? '正在提交…' : '创建并运行'}
              <span>↗</span>
            </button>
          </form>
        </Panel>
      </div>
      <div className="section-heading">
        <div>
          <h2>FAB 执行概览</h2>
          <p>HTTP 全量快照 · 每 1.5 秒查询 · 无二进制实时流</p>
        </div>
        <span className="technical">
          {displayedRun ? `RUN / ${displayedRun.runId.slice(0, 8)}` : 'AWAITING RUN'}
        </span>
      </div>
      {runError && (
        <div className="error" role="alert">
          运行查询失败：{runError}；下列已显示值可能过期。
        </div>
      )}
      <div className={`fab-grid${site.fabs.length === 1 ? ' single-fab' : ''}`}>
        {site.fabs.map((member, index) => {
          const execution = executionFor(member.fabId);
          const metrics = metricsFor(member.fabId);
          return (
            <article className="fab-card" key={member.fabId}>
              <div className="fab-card-head">
                <span className="fab-icon">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{member.code}</h3>
                  <small>独立执行域</small>
                </div>
                {execution ? (
                  <StatusPill status={execution.status} />
                ) : (
                  <span className="muted">待选择 Run</span>
                )}
              </div>
              <div className="fab-values">
                <div>
                  <span>完成 / 总 Lot</span>
                  <strong>
                    {execution
                      ? `${count(execution.completedLots)} / ${count(execution.totalLots)}`
                      : '—'}
                  </strong>
                </div>
                <div>
                  <span>仿真时间 / μs</span>
                  <strong>{execution ? count(execution.simulationTimeUs) : '—'}</strong>
                </div>
              </div>
              {execution && (
                <CompletionBar completed={execution.completedLots} total={execution.totalLots} />
              )}
              <div className="hash">
                {metrics ? `轨迹 SHA ${metrics.traceHash.slice(0, 18)}…` : '等待后端提交结果'}
              </div>
              {execution?.error && <div className="error">{execution.error}</div>}
            </article>
          );
        })}
      </div>
      <Panel title="运行记录" subtitle="站点范围内的持久化 Run；点击查看执行状态与完整结果。">
        {listError && (
          <div className="error" role="alert">
            列表查询失败：{listError}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>运行标识</th>
                <th>创建时间</th>
                <th>FAB 数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((value) => (
                <tr key={value.runId} className={runId === value.runId ? 'selected' : ''}>
                  <td className="mono">{value.runId.slice(0, 8)}</td>
                  <td>{new Date(value.createdAtUtc).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{value.executions.length}</td>
                  <td>
                    <StatusPill status={value.status} />
                  </td>
                  <td>
                    <button className="text-button" onClick={() => workbenchActions.runIdSet(value.runId)}>
                      {runId === value.runId ? '当前运行' : '查看运行'} →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && (
            <div className="empty">
              {listError ? '暂无可用运行数据' : '暂无运行记录。创建一次仿真，开始查看后端结果。'}
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}

export default function WorkbenchApp() {
  const siteId = useWorkbenchStore((state) => state.siteId);
  const runtimeRegistry = useFabRuntimeRegistry();
  const [fabIndex, setFabIndex] = useState(0);
  const sitesQuery = useQuery(sitesQueryOptions());
  const sites = sitesQuery.data ?? [];
  const loading = sitesQuery.isLoading;
  const error = sitesQuery.error ? message(sitesQuery.error) : '';
  useEffect(() => {
    if (sites.length === 0) return;
    if (!sites.some((value) => value.siteId === siteId)) workbenchActions.siteIdSet(sites[0].siteId);
  }, [sites, siteId]);
  const site = sites.find((value) => value.siteId === siteId);
  const fabs = site?.fabs ?? [];
  const selectedFab = fabs[Math.min(fabIndex, Math.max(0, fabs.length - 1))];
  useEffect(() => { setFabIndex(0); }, [siteId]);
  // The 3D link points at the final canonical URL for the selected FAB.
  const threeDeeHref = selectedFab ? fab3dPath(selectedFab.fabId) : '/';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="SemiconFab 工作台">
          <span className="brand-mark">F</span>
          <span>
            SEMICON<span className="brand-accent">FAB</span>
            <small>SIMULATION WORKSPACE</small>
          </span>
        </a>
        <div className="nav-label">工作空间</div>
        <a className="nav-link active" href="#overview">
          <span>▦</span>基地总览
          <span className="nav-dot" />
        </a>
        <a className="nav-link" href="#runs">
          <span>▷</span>仿真运行
        </a>
        <a className="nav-link" href="/equipment">
          <span>▤</span>设备目录
        </a>
        <a className="nav-link" href={threeDeeHref} target="_blank" rel="noopener noreferrer"><span>◇</span>3D FAB</a>
        {fabs.length > 1 && (
          <label className="sidebar-note">
            <span className="technical">FAB</span>
            <select value={fabIndex} onChange={(event) => setFabIndex(Number(event.target.value))}>
              {fabs.map((fab, index) => (
                <option key={fab.fabId} value={index}>{fab.code}</option>
              ))}
            </select>
          </label>
        )}
        {runtimeRegistry && runtimeRegistry.size > 0 && (
          <div className="sidebar-note">
            <span className="technical">XSTATE RUNTIMES</span>
            <p>{runtimeRegistry.size} FAB · v6</p>
          </div>
        )}
        <div className="sidebar-note">
          <span className="technical">DEVELOPMENT SLICE</span>
          <p>
            确定性离散事件仿真
            <br />
            独立 FAB · 本地开发模式
          </p>
          <span className="development-badge">开发环境</span>
        </div>
      </aside>
      <main id="overview">
        <header className="topbar">
          <span>
            工作空间 <b>/</b> 基地总览
          </span>
          <span className="topbar-right">
            <i /> REST / HTTP 轮询 <span className="avatar">DEV</span>
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">OPERATIONS OVERVIEW</div>
              <h1>
                基地仿真工作台<span> / 01</span>
              </h1>
              <p>从场景参数到执行结果，让每一次仿真清晰可追溯。</p>
            </div>
            <label className="site-picker">
              当前基地
              <select
                value={siteId}
                onChange={(event) => workbenchActions.siteIdSet(event.target.value)}
                disabled={!sites.length}
              >
                {!sites.length && <option>等待 API 数据</option>}
                {sites.map((value) => (
                  <option key={value.siteId} value={value.siteId}>
                    {value.code}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="info-banner">
            <span>ⓘ</span>
            <p>
              <strong>开发切片</strong> 合成 FIFO 加工模型 · 数据来自本地 API / Worker。
            </p>
            <span className="technical">v0.1</span>
          </div>
          {error && (
            <div className="error" role="alert">
              站点 API 错误：{error}。请检查 API、Worker 与服务器端开发密钥配置。
              <button className="ghost" onClick={() => void sitesQuery.refetch()}>
                重试
              </button>
            </div>
          )}
          {site && selectedFab && <CommandConsole siteId={site.siteId} fabId={selectedFab.fabId} />}
          {loading && <div className="empty">正在读取站点…</div>}
          {!loading && !error && !site && <div className="empty">API 未返回可用站点。</div>}
          <div id="runs">{site && <Workbench site={site} key={site.siteId} />}</div>
          <footer>
            SEMICONFAB NEXT <span>后端权威仿真 · WebGPU 视图 · 明确的模型边界</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
