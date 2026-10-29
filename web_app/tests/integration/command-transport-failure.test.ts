import { afterEach, expect, it } from 'vitest';
import type { TestFab } from '../support/command-fakes.ts';
import {
  FakeCommandEventSource,
  commandResult,
  createTestFab,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

it('surfaces transport failures and reconnects without pretending they are command outcomes', async () => {
  const source = new FakeCommandEventSource();
  let queries = 0;
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) => {
      queries += 1;
      return commandResult({ fabId, commandId, revision: 2, outcome: 'executing' });
    },
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  runtime.trackCommand('cmd-1');
  await Promise.resolve();
  const before = queries;
  source.failTransport({ message: 'SSE interrupted' });
  expect(runtime.transportFailure).toMatchObject({ message: 'SSE interrupted' });
  expect(runtime.connectionState).toBe('reconnecting');
  await expect.poll(() => queries, { timeout: 500 }).toBeGreaterThan(before);
  // Transport failures never fabricate a command failure outcome.
  expect(runtime.getProjection('cmd-1')?.outcome).toBe('executing');
  source.openStream();
  expect(runtime.connectionState).toBe('open');
});
