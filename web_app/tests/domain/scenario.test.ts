import { expect, it } from 'vitest';
import { validateScenario } from '../../src/domain/simulation/scenario';
const fields = { lotCount: '24', processTimeUs: '1000000', durationUs: '60000000', warmupUs: '0', masterSeed: '42' };
it('rejects more than 10000 lots per FAB', () => {
  expect(validateScenario({ ...fields, lotCount: '10001' })).toBeDefined();
  expect(validateScenario({ ...fields, lotCount: '10000' })).toBeUndefined();
});
it('accepts UInt64 maximum seed but rejects overflow', () => {
  expect(validateScenario({ ...fields, masterSeed: '18446744073709551615' })).toBeUndefined();
  expect(validateScenario({ ...fields, masterSeed: '18446744073709551616' })).toBeDefined();
});
it('rejects overflowing time, zero processing, noninteger and invalid warmup', () => {
  expect(validateScenario({ ...fields, durationUs: '9223372036854775808' })).toBeDefined();
  expect(validateScenario({ ...fields, processTimeUs: '0' })).toBeDefined();
  expect(validateScenario({ ...fields, masterSeed: '1.5' })).toBeDefined();
  expect(validateScenario({ ...fields, warmupUs: '60000000' })).toBeDefined();
});
