/** Ratio uses bigint arithmetic; counts never pass through floating point. */
export function CompletionBar({ completed, total }: { completed: string; total: string }) {
  const denominator = BigInt(total);
  const numerator = BigInt(completed);
  const percent = denominator > 0n ? Number((numerator * 100n / denominator) > 100n ? 100n : numerator * 100n / denominator) : 0;
  return <div className="completion"><div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Lot 完成比例"><div style={{ width: `${percent}%` }}/></div><span>{percent}%</span></div>;
}
