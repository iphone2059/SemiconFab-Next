import { afterEach, expect, it } from 'vitest';
import type { TestFab } from '../support/command-fakes.ts';
import {
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  emptyRecoveryList,
  createTestFab,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

it('bounds per-FAB authoritative reconciliation to four simultaneous queries', async () => {
  const source = new FakeCommandEventSource();
  let active = 0;
  let maxActive = 0;
  let queries = 0;
  const ids = Array.from({ length: 8 }, (_, index) => 'cmd-' + index);
  const gateway = fakeCommandGateway({
    listFabCommands: async () => emptyRecoveryList(ids.map(commandId => commandRecord({ fabId: 'fab-a', commandId, revision: 1, outcome: 'executing' }))),
    getCommandStatus: (_fabId, commandId) => {
      queries += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) =>
        setTimeout(() => {
          active -= 1;
          resolve(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
        }, 15),
      );
    },
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  for (const commandId of ids) {
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'executing' }));
    runtime.registerAcceptedCommand(commandId);
  }
  await expect.poll(() => runtime.workflowCount, { timeout: 500 }).toBe(8);
  const completed = await runtime.reconcileTracked(ids);
  expect(queries).toBe(8);
  expect(completed).toBe(8);
  expect(maxActive).toBeLessThanOrEqual(4);
  expect(maxActive).toBeGreaterThan(1);
  expect(runtime.reconciliationStats.completed).toBeGreaterThanOrEqual(8);
});
