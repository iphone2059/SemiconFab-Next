import type { ReactNode } from 'react';

/** Workbench KPI tile; Workbench is the only consumer, so it stays feature-local. */
export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}
