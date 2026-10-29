import { expect, it } from 'vitest';
import { createEquipmentCommandIdempotencyKey } from '@/api/command.schema';
import { ScopeGate } from '@/runtime/scope-gate';

it('keeps Run ScopeToken generations separate from device-command idempotency identity', () => {
  const gate = new ScopeGate();
  const first = gate.begin('run:site/fab');
  const second = gate.begin('run:site/fab');
  expect(gate.accepts(first)).toBe(false);
  expect(first.signal.aborted).toBe(true);
  expect(gate.accepts(second)).toBe(true);
  expect(second.scope).toBe(first.scope);
  expect(second.generation).toBeGreaterThan(first.generation);
  gate.dispose();
  expect(second.signal.aborted).toBe(true);

  const key = createEquipmentCommandIdempotencyKey();
  expect(key).toMatch(/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/);
  // The two identities are structurally disjoint: ScopeToken is UI abort/legacy
  // state, while the device command only carries its API idempotency key/identity.
  expect(Object.keys(second).sort()).toEqual(['generation', 'scope', 'signal']);
  expect(second).not.toHaveProperty('idempotencyKey');
});
