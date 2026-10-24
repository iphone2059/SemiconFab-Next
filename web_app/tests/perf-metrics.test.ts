import { expect, it } from 'vitest';
import { summarizeFrames, summarizeLongTasks } from '../src/perf-metrics';

it('summarizes frame-time distribution without hiding long-tail stalls', () => {
  const stats = summarizeFrames([8, 10, 12, 16, 20, 40, 80]);
  expect(stats.count).toBe(7);
  expect(stats.p50Ms).toBe(16);
  expect(stats.p95Ms).toBe(80);
  expect(stats.maxMs).toBe(80);
  expect(stats.over16_7Pct).toBeCloseTo(42.857, 2);
});

it('summarizes long tasks separately from frame time', () => {
  const stats = summarizeLongTasks([{ startTime: 10, durationMs: 60 }, { startTime: 80, durationMs: 120 }, { startTime: 210, durationMs: 30 }]);
  expect(stats.count).toBe(3);
  expect(stats.totalMs).toBe(210);
  expect(stats.p95Ms).toBe(120);
});
