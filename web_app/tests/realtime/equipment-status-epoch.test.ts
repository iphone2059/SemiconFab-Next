import { expect, it } from 'vitest';
import { compareEquipmentStatusSnapshot } from '@/realtime/equipment-status.gate';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';

/**
 * Epoch/sequence ordering contract (ADR-006 §2.5/§2.9). The comparison is pure:
 * the accepted high-water is supplied by the caller (read from the resource Atom
 * in the same synchronous commit step), so this test pins the ordering rule
 * itself without a second mutable gate copy.
 */
const scope = { siteId: 'site-1', fabId: 'fab-a' };
const base = (patch: Partial<EquipmentStatusSnapshot> = {}): EquipmentStatusSnapshot => ({
  siteId: 'site-1', fabId: 'fab-a',
  generatedAt: '2026-10-24T01:00:00Z',
  epoch: 1, sequence: 100,
  tools: [{ state: 'running' }, { state: 'running' }],
  ...patch,
});
const compare = (previous: { epoch: number; sequence: number } | undefined, candidate: unknown) =>
  compareEquipmentStatusSnapshot(scope, 2, previous, candidate);

it('requires an epoch, a sequence and a composite FAB identity', () => {
  for (const invalid of [
    { ...base(), epoch: undefined },
    { ...base(), sequence: undefined },
    { ...base(), fabId: undefined },
    { ...base(), epoch: -1 },
    { ...base(), epoch: 1.5 },
    { ...base(), sequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(compare(undefined, invalid), JSON.stringify(invalid)).toEqual({ _tag: 'Reject', reason: 'invalid' });
  }
});

it('rejects duplicate or lower sequence within an epoch, regardless of display time', () => {
  expect(compare({ epoch: 2, sequence: 100 }, base({ epoch: 2, sequence: 100 }))).toEqual({ _tag: 'Reject', reason: 'stale' });
  expect(compare({ epoch: 2, sequence: 100 }, base({ epoch: 2, sequence: 100, generatedAt: '2026-10-24T01:00:10Z' }))).toEqual({ _tag: 'Reject', reason: 'stale' });
  expect(compare({ epoch: 2, sequence: 100 }, base({ epoch: 2, sequence: 1, generatedAt: '2026-10-24T01:00:10Z' }))).toEqual({ _tag: 'Reject', reason: 'stale' });
  expect(compare({ epoch: 2, sequence: 100 }, base({ epoch: 2, sequence: 101 }))).toEqual({ _tag: 'Accept', snapshot: base({ epoch: 2, sequence: 101 }) });
});

it('accepts a higher epoch even if sequence and display timestamp go backwards', () => {
  expect(compare({ epoch: 5, sequence: 100 }, base({ epoch: 5, sequence: 100 }))).toEqual({ _tag: 'Reject', reason: 'stale' });
  const restarted = base({ epoch: 6, sequence: 0, generatedAt: '2026-10-24T01:00:00Z' });
  expect(compare({ epoch: 5, sequence: 100 }, restarted)).toEqual({ _tag: 'Accept', snapshot: restarted });
});

it('a delayed earlier epoch can never override the restarted server', () => {
  expect(compare(undefined, base({ epoch: 1, sequence: 100 }))._tag).toBe('Accept');
  expect(compare({ epoch: 2, sequence: 1 }, base({ epoch: 2, sequence: 1, tools: [{ state: 'down' }, { state: 'down' }] }))._tag).toBe('Reject');
  expect(compare({ epoch: 2, sequence: 1 }, base({ epoch: 1, sequence: 101, generatedAt: '2026-10-24T03:00:00Z' }))).toEqual({ _tag: 'Reject', reason: 'stale' });
});

it('treats a correctly scoped but late frame as ordering rejection, not malformed data', () => {
  expect(compare(undefined, base({ epoch: 1, sequence: 10 }))._tag).toBe('Accept');
  expect(compare({ epoch: 1, sequence: 10 }, base({ epoch: 1, sequence: 9 }))).toEqual({ _tag: 'Reject', reason: 'stale' });
});
