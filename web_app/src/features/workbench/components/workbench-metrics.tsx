import type { RunSummary, SiteDto } from '../../../contracts';
import { StatusPill } from './status-pill';
import { Metric } from './metric';

/** Top KPI row; values derive from the Query snapshots passed by the dashboard. */
export function WorkbenchMetrics({
  site,
  run,
  completedLots,
}: {
  site: SiteDto;
  run?: RunSummary;
  completedLots?: bigint;
}) {
  return (
    <div className="metrics">
      <Metric
        label="FAB"
        value={String(site.fabs.length).padStart(2, '0')}
        hint={`${site.fabs.map((member) => member.code).join(' · ')} · 独立执行域`}
      />
      <Metric
        label="当前运行"
        value={run ? <StatusPill status={run.status} /> : '—'}
        hint={run ? `版本 ${run.version}` : '选择或创建一个 Run'}
      />
      <Metric
        label="完成 Lot"
        value={completedLots?.toLocaleString('zh-CN') ?? '—'}
        hint="仅展示后端已提交的完整结果"
      />
      <Metric label="运行模式" value="独立仿真" hint="INDEPENDENT · 合成 FIFO 模型" />
    </div>
  );
}
