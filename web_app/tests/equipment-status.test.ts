import { afterEach, expect, it, vi } from 'vitest';
import { createOrderedEquipmentStatusConsumer, watchEquipmentStatus, type EquipmentStatusSnapshot } from '../src/equipment-status';

afterEach(() => vi.useRealTimers());

const scope = { siteId: 'site-1', fabId: 'fab-a' };

it('marks cached data stale on disconnect or stalled streams, recovers only on valid frames, and stops on abort', () => {
  vi.useFakeTimers();
  const source = { onmessage: null, onerror: null, close: vi.fn() } as unknown as EventSource;
  const controller = new AbortController();
  let state = 'waiting'; let last: EquipmentStatusSnapshot | undefined;
  watchEquipmentStatus(source, scope, snapshot => { last = snapshot; state = 'live'; }, () => { state = 'stale'; }, controller.signal);
  const snapshot = { siteId: 'site-1', fabId: 'fab-a', generatedAt: '2026-10-24T02:00:00Z', tools: [{ state: 'running' }] };
  const send = (value: unknown) => source.onmessage?.call(source, { data: JSON.stringify(value) } as MessageEvent);
  send(snapshot);
  expect(state).toBe('live');
  source.onerror?.call(source, {} as Event);
  expect(state).toBe('stale');
  send({ ...snapshot, siteId: 'other-site' });
  expect(state).toBe('stale');
  send({ ...snapshot, fabId: 'other-fab' });
  expect(state).toBe('stale');
  send({ ...snapshot, tools: null });
  expect(state).toBe('stale');
  send(snapshot);
  expect(state).toBe('live');
  vi.advanceTimersByTime(12000);
  expect(state).toBe('stale');
  expect(last).toEqual(snapshot);
  send(snapshot);
  expect(state).toBe('live');
  controller.abort();
  vi.advanceTimersByTime(20000);
  expect(state).toBe('live');
  expect(source.close).toHaveBeenCalledOnce();
});

it('accepts the legacy site-level frame without fabId but rejects a crossed FAB', () => {
  const source = { onmessage: null, onerror: null, close: vi.fn() } as unknown as EventSource;
  const controller = new AbortController();
  const onSnapshot = vi.fn();
  watchEquipmentStatus(source, scope, onSnapshot, () => {}, controller.signal);
  const send = (value: unknown) => source.onmessage?.call(source, { data: JSON.stringify(value) } as MessageEvent);
  send({ siteId: 'site-1', generatedAt: '2026-10-24T02:00:00Z', tools: [{ state: 'running' }] });
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  send({ siteId: 'site-1', fabId: 'fab-b', generatedAt: '2026-10-24T02:00:01Z', tools: [{ state: 'running' }] });
  expect(onSnapshot).toHaveBeenCalledTimes(1);
  controller.abort();
});

it('accepts only scoped full snapshots in non-decreasing timestamp order', () => {
  const onSnapshot = vi.fn();
  const onInvalid = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot, onInvalid);
  const snapshot = {
    siteId: 'site-1',
    fabId: 'fab-a',
    generatedAt: '2026-10-24T02:00:00Z',
    tools: [{ state: 'running' }, { state: 'idle' }],
  };
  expect(apply(snapshot)).toBe(true);
  expect(apply({ ...snapshot, generatedAt: '2026-10-24T01:59:59Z' })).toBe(false);
  expect(onSnapshot).toHaveBeenCalledTimes(1);

  expect(apply({ ...snapshot, siteId: 'other-site' })).toBe(false);
  expect(apply({ ...snapshot, fabId: 'other-fab' })).toBe(false);
  expect(apply({ ...snapshot, tools: [{ state: 'running' }] })).toBe(false);
  expect(apply({ ...snapshot, tools: [{ state: 'running' }, { state: 'unknown' }] })).toBe(false);
  expect(onInvalid).toHaveBeenCalledTimes(4);

  expect(apply({ ...snapshot, generatedAt: '2026-10-24T02:00:00Z' })).toBe(true);
  expect(apply({ ...snapshot, generatedAt: '2026-10-24T02:00:01Z' })).toBe(true);
  expect(onSnapshot).toHaveBeenCalledTimes(3);
});

it('orders snapshots by the server sequence even when timestamps collide', () => {
  const onSnapshot = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot);
  const base = {
    siteId: 'site-1',
    fabId: 'fab-a',
    generatedAt: '2026-10-24T02:00:00Z',
    tools: [{ state: 'running' }, { state: 'idle' }],
  };
  expect(apply({ ...base, sequence: 1 })).toBe(true);
  expect(apply({ ...base, sequence: 2 })).toBe(true);
  expect(apply({ ...base, sequence: 1 })).toBe(false);
  expect(apply({ ...base, sequence: 2 })).toBe(false);
  expect(apply({ ...base, sequence: 3, generatedAt: '2026-10-24T01:59:59Z' })).toBe(true);
  expect(apply({ ...base, sequence: 1, generatedAt: '2026-10-24T02:00:00Z' })).toBe(true);
  expect(apply({ ...base, sequence: -1 })).toBe(false);
  expect(apply({ ...base, sequence: 1.5 })).toBe(false);
  expect(onSnapshot).toHaveBeenCalledTimes(4);
});

it('keeps independent per-FAB consumers so two FABs of one site never share ordering state', () => {
  const first = vi.fn();
  const second = vi.fn();
  const fabA = createOrderedEquipmentStatusConsumer(scope, 1, first);
  const fabB = createOrderedEquipmentStatusConsumer({ siteId: 'site-1', fabId: 'fab-b' }, 1, second);
  const base = { siteId: 'site-1', generatedAt: '2026-10-24T02:00:00Z', tools: [{ state: 'running' }] };
  expect(fabA({ ...base, fabId: 'fab-a', sequence: 5 })).toBe(true);
  expect(fabB({ ...base, fabId: 'fab-b', sequence: 1 })).toBe(true);
  expect(fabA({ ...base, fabId: 'fab-a', sequence: 6 })).toBe(true);
  expect(fabB({ ...base, fabId: 'fab-b', sequence: 2 })).toBe(true);
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(2);
});
