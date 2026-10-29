import type { RunResult, RunSummary, SiteDto } from '@/contracts/app-contracts';
import { StatusPill } from '@/workbench/status-pill';
import { formatCount } from '@/workbench/workbench-format';
import { CompletionBar } from '@/workbench/completion-bar';

/** Per-FAB execution cards; data is projected from the Query snapshots. */
export function FabOverview({
  site,
  run,
  result,
  error,
}: {
  site: SiteDto;
  run?: RunSummary;
  result?: RunResult;
  error: string;
}) {
  const executionFor = (fabId: string) => run?.executions.find((value) => value.fabId === fabId);
  const metricsFor = (fabId: string) => result?.fabs.find((value) => value.fabId === fabId);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>FAB 执行概览</h2>
          <p>HTTP 全量快照 · 每 1.5 秒查询 · 无二进制实时流</p>
        </div>
        <span className="technical">
          {run ? `RUN / ${run.runId.slice(0, 8)}` : 'AWAITING RUN'}
        </span>
      </div>
      {error && (
        <div className="error" role="alert">
          运行查询失败：{error}；下列已显示值可能过期。
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
                      ? `${formatCount(execution.completedLots)} / ${formatCount(execution.totalLots)}`
                      : '—'}
                  </strong>
                </div>
                <div>
                  <span>仿真时间 / μs</span>
                  <strong>{execution ? formatCount(execution.simulationTimeUs) : '—'}</strong>
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
    </>
  );
}
