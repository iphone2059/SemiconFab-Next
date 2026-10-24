import { expect, it } from 'vitest';
import { InitializationDisposal, RecoveryFirstFrame } from '../src/babylon-lifecycle';
it('defers renderer disposal until asynchronous initialization settles and releases only once', () => {
  let disposed = 0;
  const lease = new InitializationDisposal(() => disposed++);
  lease.dispose(); lease.dispose();
  expect(disposed).toBe(0);
  lease.settled(); lease.dispose();
  expect(disposed).toBe(1);
});
it('releases immediately when unmounted after initialization', () => {
  let disposed = 0;
  const lease = new InitializationDisposal(() => disposed++);
  lease.settled();
  expect(disposed).toBe(0);
  lease.dispose(); lease.dispose();
  expect(disposed).toBe(1);
});

it('does not report device recovery until submitted first-frame work completes', async () => {
  const gate = new RecoveryFirstFrame();
  let ready = 0;
  let finish!: () => void;
  gate.lost();
  gate.restored();
  gate.submitted(1, true, new Promise<void>((resolve) => { finish = resolve; }), () => ready++, () => {});
  expect(ready).toBe(0);
  finish();
  await Promise.resolve();
  expect(ready).toBe(1);
  gate.submitted(2, true, Promise.resolve(), () => ready++, () => {});
  await Promise.resolve();
  expect(ready).toBe(1);
});

it('suppresses a pending recovery acknowledgement after another loss or disposal', async () => {
  for (const interrupt of ['lost', 'dispose'] as const) {
    const gate = new RecoveryFirstFrame();
    let finish!: () => void;
    let ready = 0;
    gate.lost(); gate.restored();
    gate.submitted(1, true, new Promise<void>((resolve) => { finish = resolve; }), () => ready++, () => {});
    gate[interrupt](); finish();
    await Promise.resolve();
    expect(ready).toBe(0);
  }
});

it('rejects restore warmup callbacks and frames with stale native resources', async () => {
  const gate = new RecoveryFirstFrame(); let ready = 0;
  gate.lost(); gate.restored(40);
  gate.submitted(40, true, Promise.resolve(), () => ready++, () => {});
  gate.submitted(41, false, Promise.resolve(), () => ready++, () => {});
  await Promise.resolve(); expect(ready).toBe(0); expect(gate.waiting).toBe(true);
  gate.submitted(42, true, Promise.resolve(), () => ready++, () => {});
  await Promise.resolve(); expect(ready).toBe(1);
});
