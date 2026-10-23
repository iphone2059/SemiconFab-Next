import { describe, expect, it } from 'vitest';
import { ScopeGate, SequenceGate, startPolling } from './state-sync';

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
  it('orders 64-bit sequences exactly and rejects duplicates/gaps', () => {
    const gate = new SequenceGate();
    gate.snapshot('9007199254740992');
    expect(gate.delta('9007199254740993')).toBe('accepted');
    expect(gate.delta('9007199254740993')).toBe('stale');
    expect(gate.delta('9007199254740995')).toBe('gap');
    expect(() => gate.delta('1.5')).toThrow();
  });
  it('suppresses an in-flight poll after disposal', async () => {
    let finish: ((value: string) => void) | undefined;
    const values: string[] = [];
    const dispose = startPolling(() => new Promise<string>(resolve => { finish = resolve; }), value => values.push(value), () => {}, 100);
    dispose();
    finish?.('old run');
    await Promise.resolve();
    expect(values).toEqual([]);
  });
});
