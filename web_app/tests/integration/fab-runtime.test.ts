import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FabRuntime } from '@/runtime/fab-runtime';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandJournalPage, CommandJournalQuery, CommandRecoveryList } from '@/contracts/command-gateway.contract';
import {
  FakeCommandEventSource,
  FakeCommandWorkflow,
  type TestFab,
  type TestFabOptions,
  commandCursor,
  commandRecord,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
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
    expect(registry.fabIdentities).toEqual([{ siteId: 'site-1', fabId: 'fab-a' }]);
    registry.startAll();
    const oldWorkflow = first.runtime.registerAcceptedCommand(commandId);
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 5, outcome: 'executing' }));
    expect(adapter(first.runtime).state).toBe('executing');

    expect(registry.remove({ siteId: 'site-1', fabId: 'fab-a' })).toBe(first.runtime);
    expect(oldSource.commandObservers).toBe(0);
    const current = createFab({ source: newSource });
    registry.register(current.runtime);
    registry.startAll();
    expect(current.runtime.registerAcceptedCommand(commandId)).not.toBe(oldWorkflow);
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
    runtime.registerAcceptedCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('automatically reconciles active commands when the source reconnects', async () => {
    const source = new FakeCommandEventSource();
    let outcome: 'accepted' | 'succeeded' = 'accepted';
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: outcome === 'accepted' ? 0 : 2, outcome })]),
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: outcome === 'accepted' ? 0 : 2, outcome }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
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
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' })]),
      getCommandStatus: () => {
        queries++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
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
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' })]),
      getCommandStatus: async (fabId, targetCommandId) => {
        if (!available) throw new Error('offline');
        return commandResult({ fabId, commandId: targetCommandId, revision: 2, outcome: 'succeeded' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
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
    runtime.registerAcceptedCommand(commandId);
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
    expect(runtime.registerAcceptedCommand(commandId)).toBeInstanceOf(XStateCommandWorkflowAdapter);
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
    registry.get({ siteId: 'site-1', fabId: 'fab-a' })!.registerAcceptedCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    lifecycle.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(registry.get({ siteId: 'site-1', fabId: 'fab-a' })!).state).toBe('accepted');
    lifecycle.dispose();
    expect(registry.size).toBe(0);
    expect(lifecycle.running).toBe(false);
  });

  it('exposes read-only workflow projections through the bounded atom store', async () => {
    const source = new FakeCommandEventSource();
    const created = createFab({ source });
    const runtime = created.runtime;
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
    const atom = runtime.projectionAtom(commandId);
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'idle', revision: -1, outcome: 'pending' });
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'accepted', revision: 1, outcome: 'accepted' });
    expect(runtime.getProjection(commandId)).toMatchObject({ state: 'accepted', revision: 1 });
  });

  it('exposes reconcileCommand only when a gateway is assembled', async () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.registerAcceptedCommand(commandId);
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
      getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 6, outcome: 'executing' }),
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
    runtime.registerAcceptedCommand(commandId);
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
    runtime.registerAcceptedCommand('cmd-1');
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
    runtime.registerAcceptedCommand('cmd-1');
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
    runtime.registerAcceptedCommand(commandId);
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
    runtime.registerAcceptedCommand(commandId);
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
      getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 5, outcome: 'executing' }),
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
    runtime.registerAcceptedCommand(commandId);
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
    runtime.registerAcceptedCommand(commandId);
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

  it('R4-02: queue-capacity drops are recorded, covered by authority, then bounded (never a silent loop)', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway();
    const { runtime } = createFab({
      source,
      gateway,
      maxConcurrentReconciliations: 1,
      maxQueuedReconciliations: 1,
      // A projection-less workflow keeps every command non-terminal and forces the
      // scheduler-side admission path (no local projection can suppress the
      // per-command reconciliation).
      createWorkflow: () => new FakeCommandWorkflow(),
    });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    for (let index = 0; index < 4; index += 1) runtime.registerAcceptedCommand('cmd-' + index);

    // The admission-time drops are recorded as generation-stamped intents and
    // proven covered by the next authoritative snapshot (the bounded post-snapshot
    // batch is sized to the remaining queue capacity, so it does not re-drop).
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
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' })]),
      getCommandStatus: async (fabId, targetCommandId) => {
        if (armed && !injected) {
          injected = true;
          // Overflow the 1-queue scheduler while the post-snapshot batch is
          // running: the drop happened AFTER the authoritative snapshot. A
          // microtask keeps the nested runtime call outside the Effect callback.
          queueMicrotask(() => {
            runtimeRef?.registerAcceptedCommand('late-1');
            runtimeRef?.registerAcceptedCommand('late-2');
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
    runtime.registerAcceptedCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    armed = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(true);
    expect(runtime.recoveryState.lastError).toMatch(/post-snapshot/);
    expect(runtime.pendingDropCount).toBeGreaterThan(0);
    expect(runtime.recoveryHistory.some((entry) =>
      entry.cause === 'error' && /post-snapshot/.test(entry.message ?? ''))).toBe(true);
  });

  it('R3-08: bounded compensation converges to Healthy when the next snapshot covers the drop', async () => {
    const source = new FakeCommandEventSource();
    let runtimeRef: FabRuntime | undefined;
    let armed = false;
    let injected = false;
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: 0, outcome: 'accepted' })]),
      getCommandStatus: async (fabId, targetCommandId) => {
        if (armed && !injected) {
          injected = true;
          queueMicrotask(() => {
            runtimeRef?.registerAcceptedCommand('late-1');
            runtimeRef?.registerAcceptedCommand('late-2');
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
    runtime.registerAcceptedCommand(commandId);
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


it('reserves capacity once per idempotency key and registers accepted commands without readmission', () => {
  const { runtime } = createFab({ maxActiveCommands: 1 });
  const reservation = runtime.reserveCommandAdmission('key-1');
  expect(runtime.reserveCommandAdmission('key-1')).toBe(reservation);
  expect(() => runtime.reserveCommandAdmission('key-2')).toThrow();
  runtime.registerAcceptedCommand('already-accepted');
  expect(() => reservation.commit('server-accepted')).not.toThrow();
  expect(reservation.state).toBe('committed');
  expect(runtime.getWorkflow('server-accepted')).toBeDefined();
});

it('expires only commands present before an empty authoritative list snapshot', async () => {
  let resolveList!: (value: ReturnType<typeof emptyRecoveryList>) => void;
  const gateway = fakeCommandGateway({
    listFabCommands: () => new Promise(resolve => { resolveList = resolve; }),
    getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 1, outcome: 'executing' }),
  });
  const { runtime } = createFab({ gateway, source: new FakeCommandEventSource() });
  runtime.registerAcceptedCommand('old');
  runtime.start();
  await expect.poll(() => typeof resolveList).toBe('function');
  runtime.registerAcceptedCommand('new');
  resolveList(emptyRecoveryList());
  await expect.poll(() => runtime.getProjection('old')?.recoveryDisposition).toBe('expired-unresolved');
  expect(runtime.getProjection('old')?.outcome).toBe('executing');
  expect(runtime.getProjection('new')?.recoveryDisposition).toBe('tracked');
});


it('treats a 404 as unresolved until a later complete list proves the command absent', async () => {
  let present = true;
  const gateway = fakeCommandGateway({
    listFabCommands: async () => emptyRecoveryList(present ? [commandRecord({ fabId: 'fab-a', commandId, revision: 1, outcome: 'executing' })] : []),
    getCommandStatus: async () => null,
  });
  const { runtime } = createFab({ source: new FakeCommandEventSource(), gateway, recovery: { backoffMs: [10], maxAttempts: 20 } });
  runtime.start();
  await expect.poll(() => gateway.listCalls.length, { timeout: 1000 }).toBeGreaterThanOrEqual(2);
  expect(runtime.recoveryState.phase).not.toBe('Healthy');
  expect(runtime.getProjection(commandId)?.recoveryDisposition).toBe('tracked');
  present = false;
  await expect.poll(() => runtime.getProjection(commandId)?.recoveryDisposition, { timeout: 1000 }).toBe('expired-unresolved');
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 1000 }).toBe('Healthy');
  expect(runtime.activeCommandCount).toBe(0);
  expect(runtime.getProjection(commandId)?.outcome).toBe('executing');
});

describe('Round 5.1 / P1-01 final Healthy barriers', () => {
  it('does not become healthy when an uncorrelated event arrives during post-snapshot reconciliation', async () => {
    const source = new FakeCommandEventSource();
    type ListMode = 'initial' | 'track' | 'block' | 'resolved';
    let listMode: ListMode = 'initial';
    let blockedList!: (value: CommandRecoveryList) => void;
    let pauseStatus = false;
    let releaseStatus!: (value: ReturnType<typeof commandResult>) => void;
    const trackedRecord = commandRecord({ fabId: 'fab-a', commandId, revision: 1, outcome: 'executing' });
    const orphanTerminal = commandRecord({ fabId: 'fab-a', commandId: 'cmd-orphan', revision: 1, outcome: 'succeeded' });
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        if (listMode === 'initial') return emptyRecoveryList([]);
        if (listMode === 'track') return emptyRecoveryList([trackedRecord]);
        if (listMode === 'resolved') return emptyRecoveryList([trackedRecord, orphanTerminal]);
        return new Promise<CommandRecoveryList>((resolve) => { blockedList = resolve; });
      },
      getCommandStatus: async (fabId, targetCommandId) => {
        if (pauseStatus && targetCommandId === commandId) {
          pauseStatus = false;
          return new Promise((resolve) => { releaseStatus = resolve; });
        }
        return commandResult({ fabId, commandId: targetCommandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway, recovery: { backoffMs: [1], maxAttempts: 8 } });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    // Dirty -> List snapshot -> the post-snapshot batch pauses on the tracked command.
    listMode = 'track';
    pauseStatus = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => typeof releaseStatus, { timeout: 1_000 }).toBe('function');

    // A realtime event for a command with no workflow is held, never ACKed, and
    // must force another authoritative pass before Healthy is re-earned.
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-orphan', revision: 1, outcome: 'succeeded' }));
    await expect.poll(() => runtime.pendingCount, { timeout: 1_000 }).toBeGreaterThan(0);
    expect(runtime.recoveryState.phase).not.toBe('Healthy');

    listMode = 'block';
    releaseStatus(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'executing' }));
    await expect.poll(() => typeof blockedList, { timeout: 1_000 }).toBe('function');
    // The next List pass is running: the uncorrelated event is still unresolved, so
    // the runtime is observably not Healthy and a new authoritative pass is pending.
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(true);
    expect(runtime.recoveryHistory.some((entry) => /uncorrelated command result held/.test(entry.message ?? ''))).toBe(true);
    expect(runtime.getProjection('cmd-orphan')).toBeUndefined();

    listMode = 'resolved';
    blockedList(emptyRecoveryList([trackedRecord, orphanTerminal]));
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.pendingCount).toBe(0);
    expect(source.pendingAcknowledgementCount).toBe(0);
    expect(runtime.lastRecoverySnapshot?.needsNextAuthoritativePass).toBe(false);
  });

  it('does not become healthy when cover succeeds but delivered acknowledgements remain', async () => {
    const source = new FakeCommandEventSource();
    type CoverMode = 'initial' | 'below' | 'cover';
    let mode: CoverMode = 'initial';
    const list = (latestSequence: number): CommandRecoveryList => ({ epoch: 'epoch-1', latestSequence, commands: [] });
    const gateway = fakeCommandGateway({
      listFabCommands: async () => (mode === 'cover' ? list(1) : list(0)),
    });
    const { runtime } = createFab({ source, gateway, recovery: { backoffMs: [1], maxAttempts: 8, maxCompensationPasses: 4 } });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    // Delivered but not consumed: the transport ledger has a pending entry above
    // the first snapshot watermark, so the cover succeeds but cannot be trusted.
    source.deliverUnprocessed(
      commandResult({ fabId: 'fab-a', commandId: 'cmd-unprocessed', revision: 1, outcome: 'succeeded' }),
      commandCursor('epoch-1', 1),
    );
    expect(source.cursors.pendingAcknowledgements).toBe(1);
    mode = 'below';
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(
      () => runtime.recoveryHistory.some((entry) => /post-cover Healthy barrier rejected/.test(entry.message ?? '')),
      { timeout: 1_500 },
    ).toBe(true);
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(source.pendingAcknowledgementCount).toBe(1);
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(true);

    mode = 'cover';
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.pendingCount).toBe(0);
    expect(source.pendingAcknowledgementCount).toBe(0);
  });

  it('does not become healthy while a same-revision outcome conflict is unresolved', async () => {
    const source = new FakeCommandEventSource();
    type ConflictMode = 'initial' | 'block' | 'resolved';
    let mode: ConflictMode = 'initial';
    let blockedList!: (value: CommandRecoveryList) => void;
    const failedRecord = commandRecord({ fabId: 'fab-a', commandId, revision: 3, outcome: 'failed' });
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        if (mode === 'initial') return emptyRecoveryList([]);
        if (mode === 'resolved') return emptyRecoveryList([failedRecord]);
        return new Promise<CommandRecoveryList>((resolve) => { blockedList = resolve; });
      },
      getCommandStatus: async (fabId, targetCommandId) => commandResult({
        fabId,
        commandId: targetCommandId,
        revision: 3,
        outcome: mode === 'resolved' ? 'failed' : 'accepted',
      }),
    });
    const { runtime } = createFab({ source, gateway, recovery: { backoffMs: [1], maxAttempts: 8, maxCompensationPasses: 4 } });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 3, outcome: 'accepted' }));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 1_000 }).toBe('accepted');
    // Same revision, different outcome: a wire conflict, never applied and never ACKed.
    // The authoritative List triggered by the conflict is blocked so the unresolved
    // state is observable: no Healthy may be claimed until authority resolves it.
    mode = 'block';
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 3, outcome: 'failed' }));
    await expect.poll(() => runtime.pendingConflictCount, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => typeof blockedList, { timeout: 1_000 }).toBe('function');
    expect(runtime.getProjection(commandId)?.outcome).toBe('accepted');
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(source.cursors.pendingAcknowledgements).toBeGreaterThan(0);
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(true);

    mode = 'resolved';
    blockedList(emptyRecoveryList([failedRecord]));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 2_000 }).toBe('failed');
    await expect.poll(() => runtime.pendingConflictCount, { timeout: 2_000 }).toBe(0);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(source.pendingAcknowledgementCount).toBe(0);
  });
});

describe('Round 5.1 / P2-01 connection lifecycle closed/failed/open', () => {
  it('treats closed as idle (not failed, no retry loop) and only open re-earns Healthy', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' })]),
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: 1, outcome: 'accepted' }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand(commandId);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    expect(runtime.connectionState).toBe('open');
    // Settle any late startup signal so the assertions below observe only the
    // effect of the deliberate 'closed' lifecycle transition.
    await flush(40);
    const listCallsAtHealthy = gateway.listCalls.length;

    // Deliberate idle close: never Healthy, never 'failed', and no recovery loop.
    source.setConnectionStatus('closed');
    await flush(30);
    expect(runtime.connectionState).toBe('closed');
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(runtime.recoveryState.phase).not.toBe('Unrecoverable');
    expect(gateway.listCalls.length).toBe(listCallsAtHealthy);
    expect(runtime.transportFailure).toBeUndefined();
    expect(runtime.recoveryHistory.some((entry) => entry.cause === 'transport-failure')).toBe(false);

    // A repeated closed notification is idempotent (no failed-retry storm).
    source.setConnectionStatus('closed');
    await flush(20);
    expect(gateway.listCalls.length).toBe(listCallsAtHealthy);
    expect(runtime.recoveryState.phase).not.toBe('Healthy');

    // A real transport failure degrades the runtime and reconciles once, never Healthy.
    source.setConnectionStatus('failed');
    await expect.poll(() => gateway.listCalls.length, { timeout: 1_000 }).toBeGreaterThan(listCallsAtHealthy);
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Degraded');
    expect(runtime.recoveryState.phase).not.toBe('Healthy');

    // Only a live connection can re-earn Healthy (through an authoritative pass).
    source.openStream();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.connectionState).toBe('open');
  });
});

describe('Round 5.1 / P2-02 on-demand command stream', () => {
  it('opens exactly one command stream per FAB, only while the FAB has command demand', async () => {
    const FAB_COUNT = 32;
    const harness = createCommandTestRuntime();
    const runtimes = new Map<string, FabRuntime>();
    const sources = new Map<string, FakeCommandEventSource>();
    const recordsByFab = new Map<string, Array<ReturnType<typeof commandRecord>>>();
    const gateway = fakeCommandGateway({
      listFabCommands: async (_siteId, fabId) => {
        // §8.3 scenario: keep FAB-33's authoritative List pending so the
        // delivered-before-202 hold is observable until the commit flushes it.
        if (fabId === 'fab-33') return new Promise<CommandRecoveryList>(() => {});
        return emptyRecoveryList(recordsByFab.get(fabId) ?? []);
      },
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({
          fabId,
          commandId: targetCommandId,
          revision: 1,
          outcome: targetCommandId === 'cmd-early' ? 'accepted' : 'executing',
        }),
    });
    const fabIds = Array.from({ length: FAB_COUNT }, (_value, index) => 'fab-' + String(index + 1).padStart(2, '0'));
    try {
      for (const fabId of fabIds) {
        const source = new FakeCommandEventSource();
        sources.set(fabId, source);
        recordsByFab.set(fabId, []);
        runtimes.set(fabId, createFabRuntime(harness, { fabId, source, gateway, lazyCommandSubscription: true }));
      }
      for (const runtime of runtimes.values()) runtime.start();
      await flush(30);
      // 32 assembled FABs => no 32 command SSE connections; idle FABs subscribe to nothing.
      for (const source of sources.values()) expect(source.commandObservers).toBe(0);
      for (const runtime of runtimes.values()) expect(runtime.recoveryState.phase).not.toBe('Unrecoverable');

      const fab07 = runtimes.get('fab-07')!;
      const source07 = sources.get('fab-07')!;
      const fab08 = runtimes.get('fab-08')!;
      const source08 = sources.get('fab-08')!;
      const records07 = recordsByFab.get('fab-07')!;
      // An admission reservation demands the stream BEFORE the HTTP POST returns.
      const reservation07 = fab07.reserveCommandAdmission('key-07');
      await expect.poll(() => source07.commandObservers, { timeout: 1_000 }).toBe(1);
      expect(sources.get('fab-06')!.commandObservers).toBe(0);
      // Ten commands share the one FAB-scoped stream.
      for (let index = 0; index < 10; index += 1) {
        const target = 'cmd-' + index;
        records07.push(commandRecord({ fabId: 'fab-07', commandId: target, revision: 1, outcome: 'executing' }));
        fab07.registerAcceptedCommand(target);
      }
      await flush(20);
      expect(source07.commandObservers).toBe(1);
      expect(sources.get('fab-06')!.commandObservers).toBe(0);
      // The submit completed: demand now comes from the active workflows only.
      reservation07.commit('cmd-0');

      // A second FAB opens its own single connection; the first is unaffected.
      const reservation08 = fab08.reserveCommandAdmission('key-08');
      await expect.poll(() => source08.commandObservers, { timeout: 1_000 }).toBe(1);
      expect(source07.commandObservers).toBe(1);
      // A failed submit releases the reservation: that FAB's idle stream closes.
      reservation08.release();
      await expect.poll(() => source08.commandObservers, { timeout: 1_000 }).toBe(0);
      expect(source07.commandObservers).toBe(1);

      // Realtime terminal results: only the last one removes the final demand.
      for (let index = 0; index < 9; index += 1) {
        const target = 'cmd-' + index;
        records07[index] = commandRecord({ fabId: 'fab-07', commandId: target, revision: 2, outcome: 'succeeded' });
        source07.emit(commandResult({ fabId: 'fab-07', commandId: target, revision: 2, outcome: 'succeeded' }));
      }
      await expect.poll(() => fab07.terminalWorkflowCount, { timeout: 1_000 }).toBe(9);
      expect(source07.commandObservers).toBe(1);

      // The last active command converges through authority (never an SSE-only claim).
      records07[9] = commandRecord({ fabId: 'fab-07', commandId: 'cmd-9', revision: 2, outcome: 'succeeded' });
      fab07.requestAuthoritativeRecovery();
      await expect.poll(() => fab07.terminalWorkflowCount, { timeout: 2_000 }).toBe(10);
      await expect.poll(() => source07.commandObservers, { timeout: 2_000 }).toBe(0);
      // The next reservation re-establishes exactly one connection.
      const nextReservation = fab07.reserveCommandAdmission('key-07-next');
      await expect.poll(() => source07.commandObservers, { timeout: 1_000 }).toBe(1);
      nextReservation.release();
      await expect.poll(() => source07.commandObservers, { timeout: 1_000 }).toBe(0);

      // §8.3: the stream is demanded before the POST completes, so a result can be
      // delivered while the command is still only reserved and flushed on commit.
      const sourceEarly = new FakeCommandEventSource();
      sources.set('fab-33', sourceEarly);
      recordsByFab.set('fab-33', []);
      const fab33 = createFabRuntime(harness, { fabId: 'fab-33', source: sourceEarly, gateway, lazyCommandSubscription: true });
      runtimes.set('fab-33', fab33);
      fab33.start();
      await flush(20);
      expect(sourceEarly.commandObservers).toBe(0);
      const earlyReservation = fab33.reserveCommandAdmission('key-early');
      await expect.poll(() => sourceEarly.commandObservers, { timeout: 1_000 }).toBe(1);
      // SSE event arrives while the command is only reserved (before HTTP 202).
      sourceEarly.emit(commandResult({ fabId: 'fab-33', commandId: 'cmd-early', revision: 1, outcome: 'accepted' }));
      await expect.poll(() => fab33.pendingCount, { timeout: 1_000 }).toBeGreaterThan(0);
      expect(fab33.getWorkflow('cmd-early')).toBeUndefined();
      earlyReservation.commit('cmd-early');
      // The commit creates the workflow and flushes the held result.
      await expect.poll(() => fab33.getProjection('cmd-early')?.outcome, { timeout: 1_000 }).toBe('accepted');
      expect(fab33.pendingCount).toBe(0);

      // Closing one FAB never touches another FAB's stream.
      expect(source07.commandObservers).toBe(0);
      expect(sourceEarly.commandObservers).toBe(1);
      await expect.poll(() => fab33.pendingCount, { timeout: 2_000 }).toBe(0);

      // Dispose closes every stream.
      for (const runtime of runtimes.values()) runtime.dispose();
      await expect.poll(
        () => [...sources.values()].every((source) => source.commandObservers === 0),
        { timeout: 1_000 },
      ).toBe(true);
    } finally {
      for (const runtime of runtimes.values()) runtime.dispose();
      await harness.dispose();
    }
  });
});

describe('Round 5.1 / P2-03 independent workflow and correlation TTLs', () => {
  it('expires correlation terminals independently while a zero workflow TTL retains the actor', async () => {
    let now = 0;
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: fakeCommandGateway(),
      retention: { resolvedWorkflowTtlMs: 0, correlationTerminalTtlMs: 1_000, sweepIntervalMs: 10, now: () => now },
    });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    runtime.registerAcceptedCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.terminalWorkflowCount, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => runtime.correlationTerminalWatermarkCount, { timeout: 1_000 }).toBe(1);
    expect(runtime.correlationWatermarkCount).toBe(1);

    now = 1_001;
    await expect.poll(() => runtime.correlationTerminalWatermarkCount, { timeout: 1_000 }).toBe(0);
    // Workflow TTL=0 means no time-based eviction; the actor stays retained.
    expect(runtime.getWorkflow(commandId)).toBeDefined();
    expect(runtime.terminalWorkflowCount).toBe(1);
  });

  it('a zero correlation TTL never disables the workflow TTL', async () => {
    let now = 0;
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: fakeCommandGateway(),
      retention: { resolvedWorkflowTtlMs: 300_000, correlationTerminalTtlMs: 0, sweepIntervalMs: 10, now: () => now },
    });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    runtime.registerAcceptedCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.terminalWorkflowCount, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => runtime.correlationTerminalWatermarkCount, { timeout: 1_000 }).toBe(1);

    now = 1_000_000;
    await expect.poll(() => runtime.terminalWorkflowCount, { timeout: 1_000 }).toBe(0);
    // Correlation TTL=0 disables only time-based watermark expiry.
    expect(runtime.correlationTerminalWatermarkCount).toBe(1);
  });

  it('dispose clears both retention timers', async () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: fakeCommandGateway(),
      retention: { sweepIntervalMs: 10 },
    });
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    runtime.registerAcceptedCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.terminalWorkflowCount, { timeout: 1_000 }).toBe(1);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    runtime.dispose();
    // workflow sweep + correlation sweep are independently owned and both cleared.
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    clearTimeoutSpy.mockRestore();
  });
});

describe('R5.4-01 terminal recovery state survives the FabRuntime lifecycle', () => {
  it('keeps Unrecoverable across stop()/start() remount and re-arms only explicit authoritative recovery', async () => {
    let failing = true;
    let listCalls = 0;
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        listCalls += 1;
        if (failing) throw new Error('HTTP 503 transient');
        return emptyRecoveryList();
      },
    });
    const source = new FakeCommandEventSource();
    const created = createFab({
      source,
      gateway,
      recovery: { backoffMs: [1], maxAttempts: 2 },
    });
    const runtime = created.runtime;
    runtime.start();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    const budget = runtime.recoveryState.attempts;
    expect(budget).toBe(2);

    // A stop()/start() remount (e.g. a runtime replacement/remount path) is an
    // internal lifecycle event: the terminal phase and its attempt budget survive.
    runtime.stop();
    runtime.start();
    await flush(30);
    expect(runtime.recoveryState.phase).toBe('Unrecoverable');
    expect(runtime.recoveryState.attempts).toBe(budget);
    const callsAfterRemount = listCalls;

    // Only a new external authoritative-recovery request opens a new episode; the
    // runtime must not stay stuck in the terminal phase when authority is healthy.
    failing = false;
    runtime.requestAuthoritativeRecovery();
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(listCalls).toBeGreaterThan(callsAfterRemount);
    expect(runtime.recoveryState.attempts).toBe(0);
  });
});
