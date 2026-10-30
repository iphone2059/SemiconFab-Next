import { afterEach, describe, expect, it } from 'vitest';
import type { FabRuntime } from '@/runtime/fab-runtime';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandJournalPage, CommandJournalQuery } from '@/contracts/command-gateway.contract';
import {
  FakeCommandEventSource,
  type TestFab,
  type TestFabOptions,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const commandId = 'cmd-1';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function createFab(options: TestFabOptions = {}): TestFab {
  const fab = createTestFab(options);
  fabs.push(fab);
  return fab;
}

function adapter(runtime: FabRuntime): XStateCommandWorkflowAdapter {
  const workflow = runtime.getWorkflow(commandId);
  if (!(workflow instanceof XStateCommandWorkflowAdapter)) throw new Error('expected XState adapter');
  return workflow;
}

describe('FabRuntime single-FAB assembly (CE-07)', () => {
  it('replaces the FAB runtime without carrying its old workflow or source into the new generation', async () => {
    const oldSource = new FakeCommandEventSource();
    const newSource = new FakeCommandEventSource();
    const registry = new FabRuntimeRegistry();
    const first = createFab({ source: oldSource });
    registry.register(first.runtime);
    expect(registry.size).toBe(1);
    expect(registry.fabIds).toEqual(['fab-a']);
    registry.startAll();
    const oldWorkflow = first.runtime.trackCommand(commandId);
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 5, outcome: 'executing' }));
    expect(adapter(first.runtime).state).toBe('executing');

    expect(registry.remove('fab-a')).toBe(first.runtime);
    expect(oldSource.commandObservers).toBe(0);
    const current = createFab({ source: newSource });
    registry.register(current.runtime);
    registry.startAll();
    expect(current.runtime.trackCommand(commandId)).not.toBe(oldWorkflow);
    expect(current.runtime.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 6, outcome: 'succeeded' }));
    newSource.emit(commandResult({ fabId: 'unknown-fab', commandId, revision: 9, outcome: 'succeeded' }));
    expect(current.runtime.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(current.runtime).context).toMatchObject({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' });
    expect(adapter(current.runtime).state).toBe('executing');
    expect(registry.size).toBe(1);
    registry.disposeAll();
    expect(registry.size).toBe(0);
    expect(newSource.commandObservers).toBe(0);
    await Promise.all([first.dispose(), current.dispose()]);
  });
});

describe('FabRuntime reconciliation and lifecycle (CE-06/CE-08)', () => {
  it('recovers a terminal result evicted before HTTP submission registers its workflow', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: 2, outcome: 'succeeded' }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    for (let index = 0; index < 256; index++) {
      source.emit(commandResult({ fabId: 'fab-a', commandId: 'other-' + index, revision: 2, outcome: 'succeeded' }));
    }
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('automatically reconciles active commands when the source reconnects', async () => {
    const source = new FakeCommandEventSource();
    let outcome: 'accepted' | 'succeeded' = 'accepted';
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: outcome === 'accepted' ? 0 : 2, outcome }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    await runtime.reconcileCommand(commandId);
    outcome = 'succeeded';
    source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('coalesces authoritative queries and ignores their results after disposal', async () => {
    const source = new FakeCommandEventSource();
    let complete!: (event: ReturnType<typeof commandResult>) => void;
    let queries = 0;
    const gateway = fakeCommandGateway({
      getCommandStatus: () => {
        queries++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    const pending = runtime.reconcileCommand(commandId);
    const concurrent = runtime.reconcileCommand(commandId);
    // The scheduler runs items on a scoped fiber; the duplicate calls merged into
    // one single-flight query.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queries).toBe(1);
    runtime.dispose();
    complete(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect(pending).resolves.toBe(false);
    await expect(concurrent).resolves.toBe(false);
    expect(queries).toBe(1);
    expect(runtime.getProjection(commandId)).toBeUndefined();
  });

  it('contains failed background recovery and retries when the connection returns', async () => {
    const source = new FakeCommandEventSource();
    let available = false;
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) => {
        if (!available) throw new Error('offline');
        return commandResult({ fabId, commandId: targetCommandId, revision: 2, outcome: 'succeeded' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
    available = true;
    source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('converges through the authoritative gateway after the stream stops (CE-06)', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({
      getCommandStatus: async () => commandResult({ fabId: 'fab-a', commandId, revision: 3, outcome: 'succeeded' }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    runtime.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(runtime).state).toBe('accepted');
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(true);
    expect(adapter(runtime).state).toBe('succeeded');
  });

  it('replays results that arrive before trackCommand created the workflow (CE-04 runtime path)', () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'succeeded' }));
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.trackCommand(commandId)).toBeInstanceOf(XStateCommandWorkflowAdapter);
    expect(adapter(runtime).state).toBe('succeeded');
    expect(runtime.pendingCount).toBe(0);
  });

  it('stops delivery and disposes workflows/runtimes on lifecycle shutdown (CE-08)', async () => {
    const source = new FakeCommandEventSource();
    const created = createFab({ source });
    const registry = new FabRuntimeRegistry();
    registry.register(created.runtime);
    const lifecycle = new FabLifecycleCoordinator(registry);
    lifecycle.start();
    registry.get('fab-a')!.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    lifecycle.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(registry.get('fab-a')!).state).toBe('accepted');
    lifecycle.dispose();
    expect(registry.size).toBe(0);
    expect(lifecycle.running).toBe(false);
  });

  it('exposes read-only workflow projections through the bounded atom store', async () => {
    const source = new FakeCommandEventSource();
    const created = createFab({ source });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand(commandId);
    const atom = runtime.projectionAtom(commandId);
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'idle', revision: -1, outcome: 'pending' });
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'accepted', revision: 1, outcome: 'accepted' });
    expect(runtime.getProjection(commandId)).toMatchObject({ state: 'accepted', revision: 1 });
  });

  it('exposes reconcileCommand only when a gateway is assembled', async () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
  });
});

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function executingRecord(revision: number) {
  return commandRecord({ fabId: 'fab-a', commandId, revision, outcome: 'executing' });
}

function dirtyWithCursor(sequence = 0) {
  return {
    reason: 'overflow' as const,
    droppedCount: 1,
    delivered: { epoch: 'epoch-1', sequence },
    gapStart: sequence + 1,
  };
}

describe('FabRuntime Round 3 recovery contract (R3-01/R3-03/R3-05/R3-07/R3-08)', () => {
  it('R3-03: rejects a foreign-FAB journal event and falls back to the authoritative list', async () => {
    const source = new FakeCommandEventSource();
    let listAttempts = 0;
    const gateway = fakeCommandGateway({
      getCommandJournalPage: async (): Promise<CommandJournalPage> => ({
        epoch: 'epoch-1',
        hasGap: false,
        firstRetainedSequence: 0,
        latestSequence: 2,
        events: [
          { sequence: 1, fabId: 'fab-b', commandId: 'other', revision: 1, outcome: 'executing', occurredAt: '2026-10-30T00:00:00.000Z' },
        ],
        nextAfterSequence: 2,
      }),
      listFabCommands: async () => {
        listAttempts += 1;
        return listAttempts === 1 ? emptyRecoveryList() : emptyRecoveryList([executingRecord(6)]);
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    const listCallsBefore = gateway.listCalls.length;

    source.emitDirty(dirtyWithCursor());
    await expect.poll(() => runtime.getProjection(commandId)?.revision, { timeout: 1_000 }).toBe(6);
    expect(gateway.journalCalls.length).toBeGreaterThanOrEqual(1);
    expect(gateway.listCalls.length).toBeGreaterThan(listCallsBefore);
    expect(runtime.recoveryState.phase).toBe('Healthy');
    expect(runtime.recoveryHistory.some((entry) =>
      entry.cause === 'replay-gap' && /foreign FAB event/.test(entry.message ?? ''))).toBe(true);
  });

  it('R3-03: validates strict increase instead of contiguous FAB sequences (no false hole)', async () => {
    const source = new FakeCommandEventSource();
    let listAttempts = 0;
    const journalQueries: CommandJournalQuery[] = [];
    const gateway = fakeCommandGateway({
      getCommandJournalPage: async (_siteId, _fabId, query): Promise<CommandJournalPage> => {
        journalQueries.push(query);
        return {
          epoch: 'epoch-1',
          hasGap: false,
          firstRetainedSequence: 0,
          latestSequence: 3,
          events: [
            { sequence: 2, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing', occurredAt: '2026-10-30T00:00:00.000Z' },
            { sequence: 2, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing', occurredAt: '2026-10-30T00:00:00.000Z' },
          ],
          nextAfterSequence: 3,
        };
      },
      listFabCommands: async () => {
        listAttempts += 1;
        return listAttempts === 1 ? emptyRecoveryList() : emptyRecoveryList([executingRecord(5)]);
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-1');
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    const listCallsBefore = gateway.listCalls.length;

    source.emitDirty(dirtyWithCursor());
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 1_000 }).toBe(5);
    expect(journalQueries[0]?.afterSequence).toBe(0);
    expect(gateway.listCalls.length).toBeGreaterThan(listCallsBefore);
    expect(runtime.recoveryHistory.some((entry) =>
      entry.cause === 'replay-gap' && /non-monotonic journal event/.test(entry.message ?? ''))).toBe(true);
  });

  it('R3-01: rejects a page whose nextAfterSequence exceeds latestSequence and recovers from the list', async () => {
    const source = new FakeCommandEventSource();
    let listAttempts = 0;
    const gateway = fakeCommandGateway({
      getCommandJournalPage: async (): Promise<CommandJournalPage> => ({
        epoch: 'epoch-1',
        hasGap: false,
        firstRetainedSequence: 0,
        latestSequence: 4,
        events: [
          { sequence: 2, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing', occurredAt: '2026-10-30T00:00:00.000Z' },
        ],
        nextAfterSequence: 9,
      }),
      listFabCommands: async () => {
        listAttempts += 1;
        return listAttempts === 1 ? emptyRecoveryList() : emptyRecoveryList([executingRecord(4)]);
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-1');
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    const listCallsBefore = gateway.listCalls.length;

    source.emitDirty(dirtyWithCursor());
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 1_000 }).toBe(4);
    expect(gateway.listCalls.length).toBeGreaterThan(listCallsBefore);
  });

  it('R3-05: bounds each recovery request with Effect.timeout, retries, then becomes Unrecoverable', async () => {
    const source = new FakeCommandEventSource();
    let journalCalls = 0;
    const gateway = fakeCommandGateway({
      // Never settles: only the owned Effect.timeout may end the request.
      getCommandJournalPage: () => {
        journalCalls += 1;
        return new Promise<never>(() => {});
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      recovery: { maxAttempts: 2, backoffMs: [1], requestTimeoutMs: 25 },
    });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    source.emitDirty(dirtyWithCursor());

    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(journalCalls).toBeGreaterThanOrEqual(2);
    expect(runtime.recoveryState.lastError).toMatch(/exceeded 25ms/);
    await expect.poll(() => runtime.physicalRequestStats.inFlight, { timeout: 1_000 }).toBe(0);
  });

  it('R3-05: dispose interrupts an in-flight recovery request and leaves no late callbacks', async () => {
    const source = new FakeCommandEventSource();
    let journalCalls = 0;
    const gateway = fakeCommandGateway({
      getCommandJournalPage: () => {
        journalCalls += 1;
        return new Promise<never>(() => {});
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      recovery: { maxAttempts: 8, backoffMs: [1], requestTimeoutMs: 60_000 },
    });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    source.emitDirty(dirtyWithCursor());
    await expect.poll(() => journalCalls, { timeout: 1_000 }).toBeGreaterThanOrEqual(1);
    expect(runtime.recoveryState.recovering).toBe(true);

    runtime.dispose();
    expect(runtime.recoveryState.phase).toBe('Dirty');
    expect(runtime.recoveryState.recovering).toBe(false);
    expect(runtime.physicalRequestStats.inFlight).toBe(0);
    const callsAtDispose = journalCalls;
    await flush(40);
    expect(journalCalls).toBe(callsAtDispose);
  });

  it('R3-05: stop() pauses and interrupts recovery; start() re-arms one authoritative pass', async () => {
    const source = new FakeCommandEventSource();
    let journalCalls = 0;
    let listAttempts = 0;
    const gateway = fakeCommandGateway({
      getCommandJournalPage: () => {
        journalCalls += 1;
        return new Promise<never>(() => {});
      },
      listFabCommands: async () => {
        listAttempts += 1;
        return listAttempts === 1 ? emptyRecoveryList() : emptyRecoveryList([executingRecord(5)]);
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      recovery: { maxAttempts: 8, backoffMs: [1], requestTimeoutMs: 60_000 },
    });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    source.emitDirty(dirtyWithCursor());
    await expect.poll(() => journalCalls, { timeout: 1_000 }).toBeGreaterThanOrEqual(1);

    runtime.stop();
    expect(runtime.recoveryState.phase).toBe('Dirty');
    const callsAtStop = journalCalls;
    await flush(30);
    expect(journalCalls).toBe(callsAtStop);

    runtime.start();
    await expect.poll(() => runtime.getProjection(commandId)?.revision, { timeout: 1_000 }).toBe(5);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    expect(listAttempts).toBeGreaterThanOrEqual(2);
  });

  it('R3-07: never reports Healthy without an authoritative gateway (display-only runtime)', async () => {
    const source = new FakeCommandEventSource();
    // Explicit display-only composition: the gateway property is passed as undefined.
    const { runtime } = createFab({ source });
    runtime.start();
    runtime.trackCommand(commandId);
    source.emitDirty({ reason: 'overflow', droppedCount: 2 });
    source.emitGap({ epoch: 'epoch-1', sequence: 2 });
    await flush(25);

    expect(runtime.recoveryAvailability).toBe('unavailable');
    expect(runtime.recoveryState.availability).toBe('unavailable');
    expect(runtime.recoveryState.phase).toBe('Unavailable');
    expect(runtime.recoveryHistory.some((entry) => entry.cause === 'no-authority')).toBe(true);
    expect(runtime.lastRecoveryList).toBeUndefined();
    expect(runtime.lastJournalPage).toBeUndefined();
    // Live events still reach the actor; only authoritative recovery is unavailable.
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    expect(runtime.getProjection(commandId)?.outcome).toBe('accepted');
  });

  it('R3-08: records queue-capacity drops as covered by the authoritative snapshot (no retry loop)', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway();
    const { runtime } = createFab({
      source,
      gateway,
      maxConcurrentReconciliations: 1,
      maxQueuedReconciliations: 1,
    });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    for (let index = 0; index < 4; index += 1) {
      const id = 'cmd-' + index;
      source.emit(commandResult({ fabId: 'fab-a', commandId: id, revision: 1, outcome: 'executing' }));
      runtime.trackCommand(id);
    }
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.coveredDropCount).toBeGreaterThanOrEqual(1);
    expect(runtime.pendingDropCount).toBe(0);
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(false);
    expect(runtime.recoveryHistory.some((entry) =>
      entry.cause === 'queue-capacity' && /covered by authoritative recovery/.test(entry.message ?? ''))).toBe(true);
    expect(gateway.listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('R3-08: a post-snapshot drop never returns to Healthy (bounded compensation = Unrecoverable)', async () => {
    const source = new FakeCommandEventSource();
    let runtimeRef: FabRuntime | undefined;
    let armed = false;
    let injected = false;
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) => {
        if (armed && !injected) {
          injected = true;
          // Overflow the 1-queue scheduler while the post-snapshot batch is
          // running: the drop happened AFTER the authoritative snapshot. A
          // microtask keeps the nested runtime call outside the Effect callback.
          queueMicrotask(() => {
            runtimeRef?.trackCommand('late-1');
            runtimeRef?.trackCommand('late-2');
          });
        }
        return commandResult({ fabId, commandId: targetCommandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      maxConcurrentReconciliations: 1,
      maxQueuedReconciliations: 1,
      recovery: { backoffMs: [1], maxAttempts: 3, maxCompensationPasses: 0 },
    });
    runtimeRef = runtime;
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    armed = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(false);
    expect(runtime.recoveryState.lastError).toMatch(/post-snapshot/);
    expect(runtime.pendingDropCount).toBe(0);
    expect(runtime.recoveryHistory.some((entry) =>
      entry.cause === 'error' && /post-snapshot/.test(entry.message ?? ''))).toBe(true);
  });

  it('R3-08: bounded compensation converges to Healthy when the next snapshot covers the drop', async () => {
    const source = new FakeCommandEventSource();
    let runtimeRef: FabRuntime | undefined;
    let armed = false;
    let injected = false;
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) => {
        if (armed && !injected) {
          injected = true;
          queueMicrotask(() => {
            runtimeRef?.trackCommand('late-1');
            runtimeRef?.trackCommand('late-2');
          });
        }
        return commandResult({ fabId, commandId: targetCommandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      maxConcurrentReconciliations: 1,
      maxQueuedReconciliations: 1,
      recovery: { backoffMs: [1], maxAttempts: 3, maxCompensationPasses: 2 },
    });
    runtimeRef = runtime;
    runtime.start();
    runtime.trackCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    armed = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    await expect.poll(() => runtime.coveredDropCount, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
    expect(runtime.pendingDropCount).toBe(0);
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(false);
    expect(gateway.listCalls.length).toBeGreaterThanOrEqual(3);
  });
});
