import { afterEach, expect, it } from 'vitest';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createTestFab,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function track(fab: TestFab): TestFab {
  fabs.push(fab);
  return fab;
}

it('CORE-007 bounds mixed-entry reconciliation to 4 in flight and 1 per command', async () => {
  const source = new FakeCommandEventSource();
  let active = 0;
  let maxActive = 0;
  const activeByCommand = new Map<string, number>();
  let maxPerCommand = 0;
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const perCommand = (activeByCommand.get(commandId) ?? 0) + 1;
      activeByCommand.set(commandId, perCommand);
      maxPerCommand = Math.max(maxPerCommand, perCommand);
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      activeByCommand.set(commandId, perCommand - 1);
      return commandResult({ fabId, commandId, revision: 1, outcome: 'executing' });
    },
  });
  const fab = track(createTestFab({ source, gateway, maxConcurrentReconciliations: 4 }));
  const runtime = fab.runtime;
  runtime.start();
  const ids = Array.from({ length: 10 }, (_, index) => 'cmd-' + index);
  for (const commandId of ids) {
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' }));
    runtime.trackCommand(commandId);
  }
  // Mixed entry points: trackCommand already scheduled every id; add the other
  // entry points in the same burst so they must merge through the one scheduler.
  source.emitGap();
  source.reconnect();
  source.failTransport();
  source.emitDirty({ reason: 'overflow', droppedCount: 9 });
  await runtime.reconcileTracked(ids);
  await expect.poll(() => runtime.reconciliationStats.completed, { timeout: 2_000 }).toBeGreaterThan(0);

  expect(maxActive).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
  expect(maxPerCommand).toBe(1);
  expect(runtime.reconciliationStats.timedOut).toBe(0);

  runtime.dispose();
  expect(runtime.reconciliationStats.queued).toBe(0);
  expect(runtime.reconciliationStats.inFlight).toBe(0);
});

it('CORE-007 explicit reconcileCommand is single-flight per command', async () => {
  const source = new FakeCommandEventSource();
  let queries = 0;
  let release!: (event: ReturnType<typeof commandResult>) => void;
  const gateway = fakeCommandGateway({
    getCommandStatus: (fabId, commandId) => {
      queries += 1;
      return new Promise((resolve) => {
        release = resolve;
      }).then(() => commandResult({ fabId, commandId, revision: 1, outcome: 'executing' }));
    },
  });
  const fab = track(createTestFab({ source, gateway }));
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('cmd-1');
  void runtime.reconcileCommand('cmd-1');
  void runtime.reconcileCommand('cmd-1');
  void runtime.reconcileAll();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(queries).toBe(1);
  release(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  await expect.poll(() => runtime.reconciliationStats.completed, { timeout: 1_000 }).toBeGreaterThanOrEqual(1);
  runtime.dispose();
});

it('CORE-007 queue capacity is bounded and drops are diagnosed, never silent', async () => {
  const source = new FakeCommandEventSource();
  const gateways: number[] = [];
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) => {
      gateways.push(1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return commandResult({ fabId, commandId, revision: 1, outcome: 'executing' });
    },
  });
  const fab = track(createTestFab({ source, gateway, maxConcurrentReconciliations: 1, maxQueuedReconciliations: 2 }));
  const runtime = fab.runtime;
  runtime.start();
  const ids = Array.from({ length: 8 }, (_, index) => 'cmd-' + index);
  for (const commandId of ids) {
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' }));
    runtime.trackCommand(commandId);
  }
  await expect.poll(() => runtime.lastReconciliationDrop !== undefined, { timeout: 2_000 }).toBe(true);
  const drop = runtime.lastReconciliationDrop;
  expect(drop?.reason).toBe('queue-capacity');
  expect(drop?.droppedTotal).toBeGreaterThanOrEqual(1);
  expect(gateways.length).toBeGreaterThan(0);
  // Dropped commands are not lost: they are retried after capacity frees.
  await expect.poll(() => runtime.reconciliationStats.completed, { timeout: 3_000 }).toBeGreaterThanOrEqual(7);
  runtime.dispose();
});

it('CORE-007 times out a hung reconciliation and releases the concurrency slot', async () => {
  const source = new FakeCommandEventSource();
  const gateway = fakeCommandGateway({
    getCommandStatus: (fabId, commandId) => {
      if (commandId === 'hung') return new Promise(() => {});
      return Promise.resolve(commandResult({ fabId, commandId, revision: 1, outcome: 'executing' }));
    },
  });
  const fab = track(
    createTestFab({ source, gateway, maxConcurrentReconciliations: 1, reconcileTimeoutMs: 30 }),
  );
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('hung');
  runtime.trackCommand('ok');
  await expect.poll(() => runtime.reconciliationStats.timedOut, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
  // The single slot was released: the queued command runs without waiting for
  // the hung promise (a leaked slot would deadlock the whole FAB queue).
  await expect.poll(() => runtime.getProjection('ok')?.outcome, { timeout: 2_000 }).toBe('executing');
  expect(runtime.reconciliationStats.inFlight).toBe(0);
  runtime.dispose();
});

it('CORE-007 dispose cancels an in-flight reconciliation and settles its caller', async () => {
  const source = new FakeCommandEventSource();
  const gateway = fakeCommandGateway({ getCommandStatus: () => new Promise(() => {}) });
  const fab = track(createTestFab({ source, gateway, reconcileTimeoutMs: 60_000 }));
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('hung');
  const pending = runtime.reconcileCommand('hung');
  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.dispose();
  await expect(pending).resolves.toBe(false);
  expect(runtime.reconciliationStats.inFlight).toBe(0);
  expect(runtime.reconciliationStats.queued).toBe(0);
});
