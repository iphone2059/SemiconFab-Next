import { afterEach, expect, it, vi } from 'vitest';
import { createEquipmentStatusGate, createOrderedEquipmentStatusConsumer } from '@/realtime/equipment-status.gate';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { watchEquipmentStatus } from '@/realtime/equipment-status.transport';

afterEach(() => vi.useRealTimers());

const scope = { siteId: 'site-1', fabId: 'fab-a' };
const base = (patch: Partial<EquipmentStatusSnapshot> = {}): EquipmentStatusSnapshot => ({
  siteId: 'site-1', fabId: 'fab-a', generatedAt: '2026-10-24T02:00:00Z',
  sequence: 1, epoch: 1, tools: [{ state: 'running' }, { state: 'idle' }],
  ...patch,
});

it('marks the feed stale after disconnect or timeout, recovers on valid frames, cleans up on abort', () => {
  vi.useFakeTimers();
  const source = { onmessage: null, onerror: null, close: vi.fn() } as unknown as EventSource;
  const controller = new AbortController();
  let state = 'waiting'; let last: EquipmentStatusSnapshot | undefined;
  watchEquipmentStatus(source, scope, snapshot => { last = snapshot; state = 'live'; }, () => { state = 'stale'; }, controller.signal);
  const send = (value: unknown) => source.onmessage?.call(source, { data: JSON.stringify(value) } as MessageEvent);
  const snapshot = base({ tools: [{ state: 'running' }] });
  send(snapshot);
  expect(state).toBe('live');
  source.onerror?.call(source, {} as Event);
  expect(state).toBe('stale');
  send({ ...snapshot, fabId: 'other-fab' });
  expect(state).toBe('stale');
  send(snapshot);
  expect(state).toBe('live');
  vi.advanceTimersByTime(12000);
  expect(state).toBe('stale');
  expect(last).toEqual(snapshot);
  controller.abort();
  expect(source.close).toHaveBeenCalledOnce();
});

it('rejects a site-only legacy frame and a crossed FAB frame', () => {
  const source = { onmessage: null, onerror: null, close: vi.fn() } as unknown as EventSource;
  const controller = new AbortController();
  const onSnapshot = vi.fn();
  watchEquipmentStatus(source, scope, onSnapshot, () => {}, controller.signal);
  const send = (value: unknown) => source.onmessage?.call(source, { data: JSON.stringify(value) } as MessageEvent);
  send({ ...base(), fabId: undefined });
  send({ ...base(), fabId: 'fab-b' });
  expect(onSnapshot).not.toHaveBeenCalled();
  send(base());
  expect(onSnapshot).toHaveBeenCalledOnce();
  controller.abort();
});

it('orders complete frames by (epoch, sequence), not timestamp', () => {
  const onSnapshot = vi.fn();
  const onInvalid = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot, onInvalid);
  expect(apply(base())).toBe(true);
  expect(apply(base({ sequence: 1, generatedAt: '2026-10-24T03:00:00Z' }))).toBe(false);
  expect(apply(base({ sequence: 2, generatedAt: '2026-10-24T01:00:00Z' }))).toBe(true);
  expect(apply(base({ epoch: 2, sequence: 0 }))).toBe(true);
  expect(apply(base({ epoch: 1, sequence: 500 }))).toBe(false);
  expect(onSnapshot).toHaveBeenCalledTimes(3);
  expect(onInvalid).not.toHaveBeenCalled();
});

it('rejects invalid frame shapes without advancing the ordering watermark', () => {
  const onInvalid = vi.fn();
  const gate = createEquipmentStatusGate(scope, 2, onInvalid);
  expect(gate.accept(base({ tools: [{ state: 'running' }] }))).toBeUndefined();
  expect(gate.accept({ ...base(), epoch: undefined })).toBeUndefined();
  expect(gate.accept({ ...base(), sequence: -1 })).toBeUndefined();
  expect(gate.accept(base())).toBeDefined();
  expect(onInvalid).toHaveBeenCalledTimes(3);
});

it('accepts a restarted epoch for the same FAB without replaying the previous generation', () => {
  const onSnapshot = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot);
  expect(apply(base({ sequence: 5 }))).toBe(true);
  expect(apply(base({ epoch: 2, sequence: 1 }))).toBe(true);
  expect(apply(base({ epoch: 1, sequence: 6 }))).toBe(false);
  expect(apply(base({ epoch: 2, sequence: 2 }))).toBe(true);
  expect(onSnapshot).toHaveBeenCalledTimes(3);
  expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({ fabId: scope.fabId, epoch: 2, sequence: 2 });
});
