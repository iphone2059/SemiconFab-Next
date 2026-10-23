import type { PropsWithChildren } from 'react';
export function Panel({ title, subtitle, children, className = '' }: PropsWithChildren<{ title: string; subtitle?: string; className?: string }>) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{children}</section>;
}
export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = { QUEUED: '排队中', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', PENDING: '待执行' };
  const normalized = status.toUpperCase();
  return <span className={`status status-${normalized.toLowerCase()}`}><i/>{labels[normalized] ?? status}</span>;
}
