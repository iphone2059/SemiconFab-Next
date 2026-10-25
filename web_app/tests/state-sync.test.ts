import { describe, expect, it } from 'vitest';
import { ScopeGate } from '../src/state-sync';

describe('scope lifecycle', () => {
  it('rejects late work even when returning to the same scope', () => {
    const gate = new ScopeGate();
    const first = gate.begin('run-a/fab-a');
    gate.begin('run-b/fab-a');
    const third = gate.begin('run-a/fab-a');
    expect(first.signal.aborted).toBe(true);
    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(third)).toBe(true);
    gate.dispose();
    expect(gate.accepts(third)).toBe(false);
  });
});
