import type { RunSummary } from '../../../contracts';
import { Panel } from './panel';
import { StatusPill } from './status-pill';

/** Persisted runs for the active site; selection stays in the Workbench store. */
export function RunHistory({
  runs,
  runId,
  error,
  onSelect,
}: {
  runs: readonly RunSummary[];
  runId: string;
  error: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <Panel title="运行记录" subtitle="站点范围内的持久化 Run；点击查看执行状态与完整结果。">
      {error && (
        <div className="error" role="alert">
          列表查询失败：{error}
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
                  <button className="text-button" onClick={() => onSelect(value.runId)}>
                    {runId === value.runId ? '当前运行' : '查看运行'} →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && (
          <div className="empty">
            {error ? '暂无可用运行数据' : '暂无运行记录。创建一次仿真，开始查看后端结果。'}
          </div>
        )}
      </div>
    </Panel>
  );
}
