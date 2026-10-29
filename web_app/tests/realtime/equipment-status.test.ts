import { afterEach, expect, it, vi } from 'vitest';
import { compareEquipmentStatusSnapshot } from '@/realtime/equipment-status.gate';
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
  // The transport never reorders; the commit comparison owns ordering. Feed the
  // decoded frames through the same pure contract the resource manager uses.
  const frames = [base(), base({ sequence: 1, generatedAt: '2026-10-24T03:00:00Z' }), base({ sequence: 2, generatedAt: '2026-10-24T01:00:00Z' }), base({ epoch: 2, sequence: 0 }), base({ epoch: 1, sequence: 500 })];
  const verdicts: string[] = [];
  let highWater: { epoch: number; sequence: number } | undefined;
  for (const frame of frames) {
    const verdict = compareEquipmentStatusSnapshot(scope, 2, highWater, frame);
    verdicts.push(verdict._tag);
    if (verdict._tag === 'Accept') highWater = { epoch: verdict.snapshot.epoch, sequence: verdict.snapshot.sequence };
  }
  expect(verdicts).toEqual(['Accept', 'Reject', 'Accept', 'Accept', 'Reject']);
});

it('a correctly scoped but late frame is an ordering rejection, not a malformed frame', () => {
  // The transport hands every structurally valid frame to the commit port; the
  // comparison rejects it as stale without marking the stream stale.
  const verdict = compareEquipmentStatusSnapshot(scope, 2, { epoch: 1, sequence: 10 }, base({ epoch: 1, sequence: 9 }));
  expect(verdict).toEqual({ _tag: 'Reject', reason: 'stale' });
});
