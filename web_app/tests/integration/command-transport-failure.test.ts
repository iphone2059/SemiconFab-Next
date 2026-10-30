import { afterEach, expect, it } from 'vitest';
import type { TestFab } from '../support/command-fakes.ts';
import {
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
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
    listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' })]),
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
  runtime.registerAcceptedCommand('cmd-1');
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

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ready-event fake whose transport capability is permanently unavailable. */
class UnavailableTransportSource extends FakeCommandEventSource {
  override readonly availability = 'unavailable' as const;
}

it('R5.4-01: transport failures and connection transitions cannot clear a terminal recovery failure', async () => {
  const source = new UnavailableTransportSource();
  let listCalls = 0;
  const gateway = fakeCommandGateway({
    listFabCommands: async () => {
      listCalls += 1;
      throw new Error('HTTP 503 transient');
    },
  });
  const fab = createTestFab({
    source,
    gateway,
    connectionStatus: 'failed',
    recovery: { backoffMs: [1], maxAttempts: 2 },
  });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
  const attempts = runtime.recoveryState.attempts;
  const callsAtTerminal = listCalls;

  // The transport interruption is still observable and diagnosed, but it is an
  // internal lifecycle event: it cannot downgrade the terminal phase or restart
  // the bounded recovery episode.
  source.failTransport({ message: 'SSE interrupted' });
  await expect.poll(() => runtime.transportFailure?.message, { timeout: 1_000 }).toBe('SSE interrupted');
  source.openStream();
  source.setConnectionStatus('closed');
  await flush(30);

  expect(runtime.recoveryState.phase).toBe('Unrecoverable');
  expect(runtime.recoveryState.attempts).toBe(attempts);
  expect(listCalls).toBe(callsAtTerminal);
});
