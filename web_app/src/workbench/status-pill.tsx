/**
 * Workbench-local run/command status pill. Owned by the Workbench feature: every
 * current consumer is Workbench, so it must not occupy a global components slot.
 */
export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = { QUEUED: '排队中', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', PENDING: '待执行' };
  const normalized = status.toUpperCase();
  return <span className={`status status-${normalized.toLowerCase()}`}><i/>{labels[normalized] ?? status}</span>;
}
