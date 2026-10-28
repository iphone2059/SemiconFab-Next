import { expect, it } from 'vitest';
import { AMHS_STATS_INTERVAL_MS, createAmhsStatsGate } from '../../src/rendering/lite/amhs-stats';

it('accepts the first sample and then at most one per interval', () => {
  const due = createAmhsStatsGate();
  expect(due(0)).toBe(true);
  expect(due(0)).toBe(false);
  expect(due(99)).toBe(false);
  expect(due(100)).toBe(true);
  expect(due(199)).toBe(false);
  expect(due(200)).toBe(true);
});

it('defaults to the 100 ms UI coalescing interval', () => {
  expect(AMHS_STATS_INTERVAL_MS).toBe(100);
  const due = createAmhsStatsGate();
  expect(due(50)).toBe(true);
  expect(due(149)).toBe(false);
  expect(due(150)).toBe(true);
});

it('rejects non-finite timestamps without consuming the interval', () => {
  const due = createAmhsStatsGate();
  expect(due(Number.NaN)).toBe(false);
  expect(due(Number.POSITIVE_INFINITY)).toBe(false);
  expect(due(Number.NEGATIVE_INFINITY)).toBe(false);
  // The first finite sample is still accepted: rejected clocks did not consume the interval.
  expect(due(0)).toBe(true);
  expect(due(99)).toBe(false);
  expect(due(Number.NaN)).toBe(false);
  expect(due(100)).toBe(true);
});

it('accepts after a huge gap', () => {
  const due = createAmhsStatsGate();
  expect(due(1)).toBe(true);
  expect(due(1 + 60_000)).toBe(true);
});

it('honors a custom interval', () => {
  const due = createAmhsStatsGate(250);
  expect(due(0)).toBe(true);
  expect(due(249)).toBe(false);
  expect(due(250)).toBe(true);
});
