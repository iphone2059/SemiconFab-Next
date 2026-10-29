import { useAtomValue } from '@effect/atom-react';
import { RegistryContext } from '@effect/atom-react';
import { useContext } from 'react';
import { useEffect } from 'react';
import type { SiteDto } from '@/contracts/app-contracts';
import { sitesResource } from '@/api/sites.resource';
import { runResource, runResultsResource, runsResource } from '@/api/runs.resource';
import { useResource } from '@/api/use-resource';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { fab3dPath } from '@/routes/route-url-mapping';
import { useFabRuntimeRegistry, useFabRuntimeVersion } from '@/app/runtime-provider';
import { workbenchAtom, workbenchActions, type WorkbenchFormState } from '@/workbench/workbench.atom';
import { CommandConsole } from '@/workbench/command-console';
import { errorMessage } from '@/workbench/error-message';
import { isCompleted } from '@/workbench/workbench-format';
import { WorkbenchMetrics } from '@/workbench/workbench-metrics';
import { RunForm } from '@/workbench/run-form';
import { FabOverview } from '@/workbench/fab-overview';
import { RunHistory } from '@/workbench/run-history';
import { useRunSubmission } from '@/workbench/use-run-submission';

/** Stable empty fallback so the sites effect does not re-run every render while loading. */
const NO_SITES: SiteDto[] = [];

/**
 * BigInt accumulation lives outside the component: the experimental Oxc compiler
 * currently drops BigInt literals inside compiled functions (emitting undefined),
 * which would turn `0n + BigInt(...)` into a runtime TypeError.
 */
function sumCompletedLots(fabs: readonly { readonly completedLots: string }[]): bigint {
  let total = 0n;
  for (const resultFab of fabs) total += BigInt(resultFab.completedLots);
  return total;
}

/**
 * Dashboard composition root: resource Atom snapshots are selected here and
 * handed to the presentational feature components; the submission command lives
 * in its controller and no server payload is copied into client state.
 */
function Workbench({ site }: { site: SiteDto }) {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const { runId, form, submitError } = useAtomValue(workbenchAtom);
  const runsView = useResource(appRuntime, runsResource);
  const scopedRuns = ((runsView.data ?? []).filter((value) => value.siteId === site.siteId));
  const listError = runsView.error !== undefined ? errorMessage(runsView.error) : '';
  const runView = useResource(appRuntime, runResource(runId ?? '__no-run__'), { enabled: !!runId });
  const runCompleted = !!runView.data && isCompleted(runView.data.status);
  // Results are only requested once the backend reports COMPLETED.
  const resultView = useResource(appRuntime, runResultsResource(runId ?? '__no-run__'), { enabled: !!runId && runCompleted });
  const run = runView.data;
  const result = resultView.data;
  const runError = runView.error !== undefined ? errorMessage(runView.error) : resultView.error !== undefined ? errorMessage(resultView.error) : '';
  const { submit, submitting } = useRunSubmission(site, form);
  useEffect(() => {
    workbenchActions.runsReceived(registry, { siteId: site.siteId, runIds: scopedRuns.map((value) => value.runId) });
  }, [scopedRuns, site.siteId, registry]);
  const setField = (field: keyof WorkbenchFormState, value: string) =>
    workbenchActions.formFieldSet(registry, { field, value });
  const displayedRun = run?.runId === runId && run.siteId === site.siteId ? run : undefined;
  const displayedResult = displayedRun && result?.runId === runId ? result : undefined;
  const completedLots = displayedResult ? sumCompletedLots(displayedResult.fabs) : undefined;
  return (
    <>
      <WorkbenchMetrics site={site} run={displayedRun} completedLots={completedLots} />
      <RunForm
        site={site}
        form={form}
        submitting={submitting}
        submitError={submitError}
        onSubmit={(event) => {
          void submit(event);
        }}
        onFieldChange={setField}
      />
      <FabOverview site={site} run={displayedRun} result={displayedResult} error={runError} />
      <RunHistory
        runs={scopedRuns}
        runId={runId}
        error={listError}
        onSelect={(next) => workbenchActions.runIdSet(registry, next)}
      />
    </>
  );
}

/** Page composition root: shell/navigation plus the keyed workbench sections. */
export default function WorkbenchApp() {
  const registry = useContext(RegistryContext);
  const appRuntime = useAppRuntime();
  const siteId = useAtomValue(workbenchAtom, (state) => state.siteId);
  const runtimeRegistry = useFabRuntimeRegistry();
  const runtimeVersion = useFabRuntimeVersion();
  // Registry contents are mutated by imperative assembly; the context version is the
  // React-visible revision that invalidates memoized size reads.
  const runtimeCount = runtimeVersion >= 0 ? runtimeRegistry?.size ?? 0 : 0;
  const fabIndex = useAtomValue(workbenchAtom, (state) => state.fabIndex);
  const sitesView = useResource(appRuntime, sitesResource);
  const sites = sitesView.data ?? NO_SITES;
  const loading = sitesView.isInitial;
  const error = sitesView.error !== undefined ? errorMessage(sitesView.error) : '';
  useEffect(() => {
    if (sites.length === 0) return;
    if (!sites.some((value) => value.siteId === siteId)) workbenchActions.siteIdSet(registry, sites[0].siteId);
  }, [sites, siteId, registry]);
  const site = sites.find((value) => value.siteId === siteId);
  const fabs = site?.fabs ?? [];
  const selectedFab = fabs[Math.min(fabIndex, Math.max(0, fabs.length - 1))];
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
            <select value={fabIndex} onChange={(event) => workbenchActions.fabIndexSet(registry, Number(event.target.value))}>
              {fabs.map((fab, index) => (
                <option key={fab.fabId} value={index}>{fab.code}</option>
              ))}
            </select>
          </label>
        )}
        {runtimeCount > 0 && (
          <div className="sidebar-note">
            <span className="technical">XSTATE RUNTIMES</span>
            <p>{runtimeCount} FAB · v6</p>
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
                onChange={(event) => workbenchActions.siteIdSet(registry, event.target.value)}
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
              <button className="ghost" onClick={() => sitesView.refresh()}>
                重试
              </button>
            </div>
          )}
          {/* Composite scope key: an in-place FAB switch replaces the console instance
              instead of carrying the previous FAB's request/history/key state across. */}
          {site && selectedFab && <CommandConsole key={`${site.siteId}:${selectedFab.fabId}`} siteId={site.siteId} fabId={selectedFab.fabId} />}
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
