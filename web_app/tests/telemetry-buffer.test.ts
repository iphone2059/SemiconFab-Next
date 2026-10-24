import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCoalescedDispatcher } from '../src/store/telemetry-buffer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('coalesces a high-frequency telemetry burst into one UI dispatch', () => {
  const received: number[] = [];
  const buffer = createCoalescedDispatcher<number>((value) => received.push(value), 100);
  buffer.push(1);
  buffer.push(2);
  buffer.push(3);
  expect(received).toEqual([]);
  vi.advanceTimersByTime(99);
  expect(received).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(received).toEqual([3]);
});

it('flushes explicitly and cancels pending work on unmount', () => {
  const received: string[] = [];
  const buffer = createCoalescedDispatcher<string>((value) => received.push(value), 100);
  buffer.push('a');
  buffer.flush();
  expect(received).toEqual(['a']);
  buffer.push('b');
  buffer.cancel();
  vi.advanceTimersByTime(200);
  expect(received).toEqual(['a']);
});
