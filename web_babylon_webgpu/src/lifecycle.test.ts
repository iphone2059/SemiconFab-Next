import { expect, it } from 'vitest';
import { InitializationDisposal } from './lifecycle';
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
