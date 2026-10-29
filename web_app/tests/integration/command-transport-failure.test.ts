import { expect, it } from 'vitest';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes.ts';

it('surfaces transport failures and reconnects without pretending they are command outcomes', async () => {
  const source = new FakeCommandEventSource();
  let queries = 0;
  const gateway = { getCommandStatus: async (fabId: string, commandId: string) => {
    queries += 1;
    return commandResult({ fabId, commandId, revision: 2, outcome: 'executing' });
  } };
  const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
  runtime.start();
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  runtime.trackCommand('cmd-1');
  await Promise.resolve();
  const before = queries;
  source.failTransport({ message: 'SSE interrupted' });
  expect(runtime.transportFailure).toMatchObject({ message: 'SSE interrupted' });
  expect(runtime.connectionState).toBe('reconnecting');
  await expect.poll(() => queries, { timeout: 300 }).toBeGreaterThan(before);
  // Transport failures never fabricate a command failure outcome.
  expect(runtime.getProjection('cmd-1')?.outcome).toBe('executing');
  source.openStream();
  expect(runtime.connectionState).toBe('open');
  runtime.dispose();
});
