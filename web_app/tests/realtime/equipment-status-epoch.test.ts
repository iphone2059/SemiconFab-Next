import { expect, it, vi } from 'vitest';
import { createEquipmentStatusGate, createOrderedEquipmentStatusConsumer } from '@/realtime/equipment-status.gate';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';

const scope = { siteId: 'site-1', fabId: 'fab-a' };
const base = (patch: Partial<EquipmentStatusSnapshot> = {}): EquipmentStatusSnapshot => ({
  siteId: 'site-1', fabId: 'fab-a',
  generatedAt: '2026-10-24T01:00:00Z',
  epoch: 1, sequence: 100,
  tools: [{ state: 'running' }, { state: 'running' }],
  ...patch,
});

it('requires an epoch, a sequence and a composite FAB identity', () => {
  const onInvalid = vi.fn();
  const gate = createEquipmentStatusGate(scope, 2, onInvalid);
  for (const invalid of [
    { ...base(), epoch: undefined },
    { ...base(), sequence: undefined },
    { ...base(), fabId: undefined },
    { ...base(), epoch: -1 },
    { ...base(), epoch: 1.5 },
    { ...base(), sequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) expect(gate.accept(invalid)).toBeUndefined();
  expect(onInvalid).toHaveBeenCalledTimes(6);
});

it('rejects duplicate or lower sequence within an epoch, regardless of display time', () => {
  const gate = createEquipmentStatusGate(scope, 2);
  expect(gate.accept(base({ epoch: 2, sequence: 100 }))).toBeDefined();
  expect(gate.accept(base({ epoch: 2, sequence: 100, generatedAt: '2026-10-24T01:00:10Z' }))).toBeUndefined();
  expect(gate.accept(base({ epoch: 2, sequence: 1, generatedAt: '2026-10-24T01:00:10Z' }))).toBeUndefined();
  expect(gate.accept(base({ epoch: 2, sequence: 101 }))).toBeDefined();
});

it('accepts a higher epoch even if sequence and display timestamp go backwards', () => {
  const gate = createEquipmentStatusGate(scope, 2);
  expect(gate.accept(base({ epoch: 5, sequence: 100, generatedAt: '2026-10-24T02:00:00Z' }))).toBeDefined();
  const restarted = base({ epoch: 6, sequence: 0, generatedAt: '2026-10-24T01:00:00Z' });
  expect(gate.accept(restarted)).toBe(restarted);
});

it('does not let a delayed earlier epoch override the restarted server', () => {
  const onSnapshot = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot);
  expect(apply(base({ epoch: 1, sequence: 100 }))).toBe(true);
  expect(apply(base({ epoch: 2, sequence: 1, tools: [{ state: 'down' }, { state: 'down' }] }))).toBe(true);
  expect(apply(base({ epoch: 1, sequence: 101, generatedAt: '2026-10-24T03:00:00Z' }))).toBe(false);
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(onSnapshot.mock.calls[1][0].tools[0].state).toBe('down');
});

it('treats a correctly scoped but late frame as ordering rejection, not malformed data', () => {
  const onInvalid = vi.fn();
  const gate = createEquipmentStatusGate(scope, 2, onInvalid);
  expect(gate.accept(base({ epoch: 1, sequence: 10 }))).toBeDefined();
  expect(gate.accept(base({ epoch: 1, sequence: 9 }))).toBeUndefined();
  expect(onInvalid).not.toHaveBeenCalled();
});
