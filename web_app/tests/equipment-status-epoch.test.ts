import { expect, it, vi } from 'vitest';
import {
  createEquipmentStatusGate,
  createOrderedEquipmentStatusConsumer,
  type EquipmentStatusSnapshot,
} from '../src/equipment-status';

/**
 * A03: sequence + timestamp cannot distinguish server epochs. The additive
 * `epoch` field orders server generations; frames without it keep the legacy
 * (sequence, timestamp) behaviour exactly.
 */

const scope = { siteId: 'site-1', fabId: 'fab-a' };
const base = (patch: Partial<EquipmentStatusSnapshot>): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId: 'fab-a',
  generatedAt: '2026-10-24T01:00:00Z',
  sequence: 100,
  tools: [{ state: 'running' }, { state: 'running' }],
  ...patch,
});

it('A03: a restarted server (higher epoch) is not rolled back by a delayed old-server frame', () => {
  const onSnapshot = vi.fn();
  const apply = createOrderedEquipmentStatusConsumer(scope, 2, onSnapshot);
  // 1) Running at 01:00:00 from server generation 1.
  expect(apply(base({ epoch: 1, sequence: 100, generatedAt: '2026-10-24T01:00:00Z' }))).toBe(true);
  // 2) Server restart: new epoch, sequence restarts at 1, newer display time, down.
  expect(apply(base({
    epoch: 2, sequence: 1, generatedAt: '2026-10-24T01:00:10Z',
    tools: [{ state: 'down' }, { state: 'down' }],
  }))).toBe(true);
  // 3) Delayed frame from the old server generation: higher sequence but lower epoch.
  expect(apply(base({
    epoch: 1, sequence: 101, generatedAt: '2026-10-24T01:00:05Z',
    tools: [{ state: 'running' }, { state: 'running' }],
  }))).toBe(false);
  expect(onSnapshot).toHaveBeenCalledTimes(2);
  expect(onSnapshot.mock.calls[1][0].tools[0].state).toBe('down');
});

it('A03: a higher epoch is accepted even with a lower sequence and older display time', () => {
  const gate = createEquipmentStatusGate(scope, 2);
  expect(gate.accept(base({ epoch: 5, sequence: 50, generatedAt: '2026-10-24T02:00:00Z' }))).toBeDefined();
  const restarted = base({ epoch: 6, sequence: 0, generatedAt: '2026-10-24T01:00:00Z', tools: [{ state: 'idle' }, { state: 'idle' }] });
  expect(gate.accept(restarted)).toBe(restarted);
});

it('A03: a lower-epoch frame is stale even when its sequence and timestamp are newer', () => {
  const gate = createEquipmentStatusGate(scope, 2);
  expect(gate.accept(base({ epoch: 3, sequence: 10, generatedAt: '2026-10-24T01:00:00Z' }))).toBeDefined();
  expect(gate.accept(base({ epoch: 2, sequence: 999, generatedAt: '2026-10-24T03:00:00Z' }))).toBeUndefined();
  expect(gate.accept(base({ epoch: 3, sequence: 11, generatedAt: '2026-10-24T01:00:01Z' }))).toBeDefined();
});

it('A03: epoch is validated like sequence (safe non-negative integer)', () => {
  const onInvalid = vi.fn();
  const gate = createEquipmentStatusGate(scope, 2, onInvalid);
  expect(gate.accept(base({ epoch: -1 }))).toBeUndefined();
  expect(gate.accept(base({ epoch: 1.5 }))).toBeUndefined();
  expect(gate.accept(base({ epoch: Number.MAX_SAFE_INTEGER + 1 }))).toBeUndefined();
  expect(onInvalid).toHaveBeenCalledTimes(3);
});

it('A03: legacy frames without an epoch keep the current sequence/timestamp behaviour', () => {
  const sequenceSnapshots = vi.fn();
  const sequenceApply = createOrderedEquipmentStatusConsumer(scope, 2, sequenceSnapshots);
  const frame = (sequence: number, generatedAt: string) => base({ sequence, generatedAt });
  expect(sequenceApply(frame(1, '2026-10-24T02:00:00Z'))).toBe(true);
  expect(sequenceApply(frame(2, '2026-10-24T02:00:00Z'))).toBe(true);
  expect(sequenceApply(frame(1, '2026-10-24T02:00:00Z'))).toBe(false);
  // Same rules the pre-epoch consumer encoded: a lower sequence with a newer
  // timestamp is the legacy server-restart heuristic, not a stale frame.
  expect(sequenceApply(frame(3, '2026-10-24T01:59:59Z'))).toBe(true);
  expect(sequenceApply(frame(1, '2026-10-24T02:00:00Z'))).toBe(true);
  expect(sequenceSnapshots).toHaveBeenCalledTimes(4);

  const timestampSnapshots = vi.fn();
  const timestampApply = createOrderedEquipmentStatusConsumer(scope, 2, timestampSnapshots);
  expect(timestampApply(base({ sequence: undefined, generatedAt: '2026-10-24T02:00:00Z' }))).toBe(true);
  expect(timestampApply(base({ sequence: undefined, generatedAt: '2026-10-24T01:59:59Z' }))).toBe(false);
  expect(timestampApply(base({ sequence: undefined, generatedAt: '2026-10-24T02:00:00Z' }))).toBe(true);
  expect(timestampSnapshots).toHaveBeenCalledTimes(2);
});
