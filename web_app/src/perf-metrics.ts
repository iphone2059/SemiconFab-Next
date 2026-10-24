export interface FrameStats {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  over16_7Pct: number;
  over33_3Pct: number;
}
const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return values[index];
};
export function summarizeFrames(frames: readonly number[]): FrameStats {
  const values = sorted(frames.filter((value) => Number.isFinite(value) && value >= 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: values[0] ?? 0,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values[values.length - 1] ?? 0,
    meanMs: values.length ? total / values.length : 0,
    over16_7Pct: values.length ? values.filter((value) => value > 16.7).length / values.length * 100 : 0,
    over33_3Pct: values.length ? values.filter((value) => value > 33.3).length / values.length * 100 : 0,
  };
}
export interface LongTaskSample { startTime: number; durationMs: number }
export function summarizeLongTasks(tasks: readonly LongTaskSample[]): { count: number; totalMs: number; p95Ms: number; maxMs: number } {
  const values = sorted(tasks.map((task) => task.durationMs));
  return {
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p95Ms: percentile(values, 95),
    maxMs: values[values.length - 1] ?? 0,
  };
}
