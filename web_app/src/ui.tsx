import type { AriaRole, PropsWithChildren, ReactNode, Ref } from 'react';

type PanelProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
  className?: string;
  actions?: ReactNode;
  containerRef?: Ref<HTMLElement>;
  role?: AriaRole;
  'aria-modal'?: boolean;
  'aria-label'?: string;
}>;

export function Panel({
  title,
  subtitle,
  children,
  className = '',
  actions,
  containerRef,
  role,
  'aria-modal': ariaModal,
  'aria-label': ariaLabel,
}: PanelProps) {
  return (
    <section
      ref={containerRef}
      className={`panel ${className}`}
      role={role}
      aria-modal={ariaModal}
      aria-label={ariaLabel}
    >
      <div className="panel-heading">
        <div className="panel-heading-copy">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="panel-heading-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = { QUEUED: '排队中', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', PENDING: '待执行' };
  const normalized = status.toUpperCase();
  return <span className={`status status-${normalized.toLowerCase()}`}><i/>{labels[normalized] ?? status}</span>;
}
