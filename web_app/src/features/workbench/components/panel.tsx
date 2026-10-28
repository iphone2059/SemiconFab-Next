import type { AriaRole, PropsWithChildren, ReactNode, Ref } from 'react';
import { classNames } from '../../../components/class-names';

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

/**
 * Workbench-local panel primitive. Owned by the Workbench feature because every
 * current consumer is Workbench; it is not a global design-system component until
 * a second feature (or an application-level owner) actually needs it.
 */
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
      className={classNames('panel', className)}
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
