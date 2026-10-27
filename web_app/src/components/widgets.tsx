import type { ReactNode } from 'react';
export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}
