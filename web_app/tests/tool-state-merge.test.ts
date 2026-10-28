import { expect, it } from 'vitest';
import type { FabToolState } from '../src/domain/fab/fab-layout';
import { createToolStateMerger, type ToolStateMerger } from '../src/features/twin/tool-state-merge';

const BASE: readonly FabToolState[] = ['running', 'idle', 'down', 'maint', 'running'];
const LIVE: readonly FabToolState[] = ['idle', 'down', 'running', 'running', 'maint'];

function merge(): ToolStateMerger {
  return createToolStateMerger();
}

it('merges live telemetry over the base states on the first call', () => {
  const merger = merge();
  expect(merger(BASE, LIVE)).toEqual(['idle', 'down', 'running', 'running', 'maint']);
});

it('returns the exact same array reference for unchanged base and live refs', () => {
  const merger = merge();
  const first = merger(BASE, LIVE);
  const second = merger(BASE, LIVE);
  expect(second).toBe(first);
  expect(merger(BASE, LIVE)).toBe(first);
});

it('returns the base reference when live telemetry is undefined', () => {
  const merger = merge();
  expect(merger(BASE, undefined)).toBe(BASE);
  // A repeated poll with no telemetry snapshot keeps the base reference.
  expect(merger(BASE, undefined)).toBe(BASE);
});

it('allocates a new array when the live reference changes', () => {
  const merger = merge();
  const first = merger(BASE, LIVE);
  const nextLive: readonly FabToolState[] = ['down', 'maint', 'idle', 'idle', 'down'];
  const second = merger(BASE, nextLive);
  expect(second).not.toBe(first);
  expect(second).not.toBe(BASE);
  expect(second).toEqual(['down', 'maint', 'idle', 'idle', 'down']);
});

it('allocates a new array when the base reference changes', () => {
  const merger = merge();
  const first = merger(BASE, LIVE);
  const nextBase: readonly FabToolState[] = ['maint', 'maint', 'maint', 'maint', 'maint'];
  const second = merger(BASE, undefined);
  const third = merger(nextBase, LIVE);
  expect(second).toBe(BASE);
  expect(third).not.toBe(first);
  expect(third).not.toBe(nextBase);
  expect(third).toEqual(['idle', 'down', 'running', 'running', 'maint']);
});

it('handles live telemetry shorter than base by keeping trailing base states', () => {
  const merger = merge();
  expect(merger(BASE, ['idle', 'down'])).toEqual(['idle', 'down', 'down', 'maint', 'running']);
});

it('ignores live telemetry entries beyond the base length', () => {
  const merger = merge();
  const live: readonly FabToolState[] = [...LIVE, 'idle', 'down', 'maint'];
  const result = merger(BASE, live);
  expect(result).toHaveLength(BASE.length);
  expect(result).toEqual(['idle', 'down', 'running', 'running', 'maint']);
});

it('never mutates the base array', () => {
  const merger = merge();
  const base = [...BASE];
  const snapshot = [...base];
  merger(base, LIVE);
  merger(base, ['down', 'down', 'down', 'down', 'down']);
  expect(base).toEqual(snapshot);
  expect(merger(BASE, LIVE)).toEqual(['idle', 'down', 'running', 'running', 'maint']);
  expect(BASE).toEqual(['running', 'idle', 'down', 'maint', 'running']);
});

it('reuses the result after a cache hit even when live was previously undefined', () => {
  const merger = merge();
  expect(merger(BASE, undefined)).toBe(BASE);
  const merged = merger(BASE, LIVE);
  expect(merged).toEqual(['idle', 'down', 'running', 'running', 'maint']);
  expect(merger(BASE, LIVE)).toBe(merged);
});
