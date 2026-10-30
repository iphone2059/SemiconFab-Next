import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandRecoveryList } from '@/contracts/command-gateway.contract';
import type { FabRuntime } from '@/runtime/fab-runtime';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import type { TestFab, TestFabOptions } from '../support/command-fakes.ts';
import {
  CountingCommandWorkflow,
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabId = 'fab-a';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function createFab(options: TestFabOptions = {}): TestFab {
  const fab = createTestFab({ fabId, ...options });
  fabs.push(fab);
  return fab;
}

function nonTerminalGateway(calls?: string[]) {
  return fakeCommandGateway({
    listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId, commandId: 'cmd-1', revision: 0, outcome: 'accepted' })]),
    getCommandStatus: async (targetFab, commandId) => {
      calls?.push(commandId);
      return commandResult({ fabId: targetFab, commandId, revision: 0, outcome: 'accepted' });
    },
  });
}

describe('FabRuntime replay-gap reconciliation (batch 2/3)', () => {
  it('coalesces a replay-gap/reconnect burst into one authoritative pass over active commands', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList(['cmd-1', 'cmd-2'].map(commandId => commandRecord({ fabId, commandId, revision: 1, outcome: 'executing' }))),
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    runtime.registerAcceptedCommand('cmd-2');
    // Settle the startup recovery pass and submit-time reconciliation, then watch
    // only the gap/reconnect burst (ADR-010 coalescing).
    await runtime.reconcileAll();
    await new Promise((resolve) => setTimeout(resolve, 30));
    calls.length = 0;

    source.emitGap();
    source.reconnect();
    source.emitGap();
    await expect.poll(() => calls.length, { timeout: 500 }).toBe(2);
    expect([...calls].sort()).toEqual(['cmd-1', 'cmd-2']);
    // No duplicate per-command queries from the same signal burst.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.length).toBe(2);
  });

  it('ignores gap signals from a disposed generation of the same FAB', async () => {
    const oldSource = new FakeCommandEventSource();
    const currentSource = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList([commandRecord({ fabId, commandId: 'cmd', revision: 1, outcome: 'executing' })]),
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(targetFab + ':' + commandId);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const previous = createFab({ source: oldSource, gateway });
    previous.runtime.start();
    previous.runtime.registerAcceptedCommand('cmd');
    await previous.runtime.reconcileAll();
    previous.runtime.dispose();
    const current = createFab({ source: currentSource, gateway });
    current.runtime.start();
    current.runtime.registerAcceptedCommand('cmd');
    await current.runtime.reconcileAll();
    // Let the startup list recovery pass finish before counting the disposed generation.
    await new Promise((resolve) => setTimeout(resolve, 30));
    calls.length = 0;

    expect(oldSource.gapObservers).toBe(0);
    oldSource.emitGap();
    oldSource.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual([]);

    currentSource.emitGap();
    await expect.poll(() => calls.length, { timeout: 500 }).toBe(1);
    expect(calls).toEqual(['fab-a:cmd']);
  });

  it('reconciles only tracked active commands; terminal and unknown ids are ignored', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway = fakeCommandGateway({
      listFabCommands: async () => emptyRecoveryList([
        commandRecord({ fabId, commandId: 'active', revision: 1, outcome: 'executing' }),
        commandRecord({ fabId, commandId: 'done', revision: 2, outcome: 'succeeded' }),
      ]),
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandId === 'done'
          ? commandResult({ fabId: targetFab, commandId, revision: 2, outcome: 'succeeded' })
          : commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.registerAcceptedCommand('active');
    source.emit(commandResult({ fabId, commandId: 'active', revision: 1, outcome: 'executing' }));
    runtime.registerAcceptedCommand('done');
    source.emit(commandResult({ fabId, commandId: 'done', revision: 2, outcome: 'succeeded' }));
    await runtime.reconcileAll();
    calls.length = 0;

    await expect(runtime.reconcileTracked(['active', 'done', 'missing'])).resolves.toBe(1);
    expect(calls).toEqual(['active']);
    await expect(runtime.reconcileAll()).resolves.toBe(1);
    expect(calls).toEqual(['active', 'active']);
  });

  it('reconciles a command tracked after a replay gap when no local evidence exists', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const { runtime } = createFab({ source, gateway: nonTerminalGateway(calls) });
    runtime.start();
    expect(runtime.hasLocalEvidence('cmd-1')).toBe(false);
    source.emitGap({ epoch: 'epoch-2', sequence: 4 });
    runtime.registerAcceptedCommand('cmd-1');
    await expect.poll(() => calls.length, { timeout: 500 }).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe('cmd-1');
    // Local evidence is tracked from the same correlation watermark as delivery.
    source.emit(commandResult({ fabId, commandId: 'cmd-1', revision: 3, outcome: 'executing' }));
    expect(runtime.hasLocalEvidence('cmd-1')).toBe(true);
  });

  it('unsubscribes gap/reconnect signals on stop and dispose (CE-08)', () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.start();
    expect(source.reconnectObservers).toBe(1);
    expect(source.gapObservers).toBe(1);
    expect(source.commandObservers).toBe(1);
    expect(source.dirtyObservers).toBe(1);
    runtime.stop();
    expect(source.reconnectObservers).toBe(0);
    expect(source.gapObservers).toBe(0);
    expect(source.commandObservers).toBe(0);
    expect(source.dirtyObservers).toBe(0);
    runtime.start();
    runtime.dispose();
    expect(source.reconnectObservers).toBe(0);
    expect(source.gapObservers).toBe(0);
    expect(source.commandObservers).toBe(0);
    expect(source.dirtyObservers).toBe(0);
  });
});

/** Minimal workflow whose projection access is counted, to expose per-delivery scans. */
class CountingWorkflow implements CommandWorkflow {
  markExpiredUnresolved(): void {}
  accesses = 0;
  private revisionValue = -1;
  private outcomeValue: CommandOutcome | 'pending' = 'pending';

  receiveRealtime(event: CommandResultEvent): void {
    if (event.revision <= this.revisionValue) return;
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
  }

  receiveAuthoritative(event: CommandResultEvent): void {
    if (event.revision < this.revisionValue) return;
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    this.accesses += 1;
    return {
      state: this.outcomeValue === 'pending' ? 'idle' : this.outcomeValue,
      revision: this.revisionValue,
      outcome: this.outcomeValue,
      recoveryDisposition: 'tracked',
    };
  }
}

describe('FabRuntime bounded workflow/correlation retention (batch 2/3)', () => {
  it('disables time eviction at TTL zero while enforcing the resolved count limit', () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const source = new FakeCommandEventSource();
      const { runtime } = createFab({ source, retention: { resolvedWorkflowTtlMs: 0, maxResolvedWorkflows: 1 } });
      runtime.start();
      setTimeoutSpy.mockClear();
      runtime.registerAcceptedCommand('done-1');
      source.emit(commandResult({ fabId, commandId: 'done-1', revision: 1, outcome: 'succeeded' }));
      vi.runAllTicks();
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1)).toBe(false);
      vi.advanceTimersByTime(1_000_000);
      expect(runtime.getWorkflow('done-1')).toBeDefined();
      runtime.registerAcceptedCommand('done-2');
      source.emit(commandResult({ fabId, commandId: 'done-2', revision: 1, outcome: 'succeeded' }));
      vi.runAllTicks();
      expect(runtime.getWorkflow('done-1')).toBeUndefined();
      expect(runtime.getWorkflow('done-2')).toBeDefined();
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it('registers active commands without visiting all earlier workflow projections', () => {
    const workflows: CountingWorkflow[] = [];
    const fab = createFab({
      source: new FakeCommandEventSource(),
      // R4-08: the default admission bound is 64; this test intentionally tracks
      // 100 active commands for the projection-visit proof.
      maxActiveCommands: 256,
      createWorkflow: () => {
        const workflow = new CountingWorkflow();
        workflows.push(workflow);
        return workflow;
      },
    });
    for (let index = 0; index < 100; index++) fab.runtime.registerAcceptedCommand('cmd-' + index);
    // A registration change projects only the new command: O(1) per registration,
    // never a scan over every earlier workflow (the audited path was O(N) per track).
    expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(workflows.length * 10);
  });

  it('reconciles a batch with only linear projection visits and retains terminal outcomes', async () => {
    const workflows: CountingWorkflow[] = [];
    let outcome: CommandOutcome = 'executing';
    const { runtime } = createFab({
      source: new FakeCommandEventSource(),
      gateway: fakeCommandGateway({
        getCommandStatus: async (targetFab, commandId) =>
          commandResult({ fabId: targetFab, commandId, revision: outcome === 'executing' ? 1 : 2, outcome }),
      }),
      createWorkflow: () => {
        const workflow = new CountingWorkflow();
        workflows.push(workflow);
        return workflow;
      },
    });
    for (let index = 0; index < 40; index++) runtime.registerAcceptedCommand('cmd-' + index);
    await runtime.reconcileAll();
    for (const workflow of workflows) workflow.accesses = 0;
    outcome = 'succeeded';
    await expect(runtime.reconcileAll()).resolves.toBe(40);
    expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(workflows.length * 10);
    expect(runtime.terminalWorkflowCount).toBe(40);
    expect(runtime.getProjection('cmd-0')?.outcome).toBe('succeeded');
  });

  it('retains active workflows and evicts terminal workflows by max with a recent projection kept', () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: nonTerminalGateway(),
      createWorkflow: (targetFab, commandId) => new CountingCommandWorkflow(targetFab, commandId),
      retention: { resolvedWorkflowTtlMs: 60_000, maxResolvedWorkflows: 2, sweepIntervalMs: 1_000 },
    });
    runtime.start();
    runtime.registerAcceptedCommand('active');
    source.emit(commandResult({ fabId, commandId: 'active', revision: 1, outcome: 'accepted' }));
    for (const commandId of ['done-1', 'done-2', 'done-3']) {
      runtime.registerAcceptedCommand(commandId);
      source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }));
    }
    expect(runtime.terminalWorkflowCount).toBe(2);
    expect(runtime.workflowCount).toBe(3); // one active + two retained terminals
    expect(runtime.getWorkflow('active')).toBeDefined();
    expect(runtime.getWorkflow('done-1')).toBeUndefined();
    expect(runtime.getProjection('done-1')).toMatchObject({ outcome: 'succeeded' });
    expect(runtime.retainedProjectionCount).toBe(1);
    runtime.dispose();
    expect(runtime.workflowCount).toBe(0);
    expect(runtime.retainedProjectionCount).toBe(0);
  });

  it('disposes terminal actors after the TTL while keeping the recent UI projection', async () => {
    let now = 0;
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: nonTerminalGateway(),
      createWorkflow: (targetFab, commandId) => new CountingCommandWorkflow(targetFab, commandId),
      retention: { resolvedWorkflowTtlMs: 100, sweepIntervalMs: 5, now: () => now },
    });
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    source.emit(commandResult({ fabId, commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
    expect(runtime.workflowCount).toBe(1);
    now = 1_000;
    await expect.poll(() => runtime.workflowCount, { timeout: 1_000 }).toBe(0);
    expect(runtime.terminalWorkflowCount).toBe(0);
    expect(runtime.getProjection('cmd-1')).toMatchObject({ state: 'succeeded', outcome: 'succeeded' });
    expect(runtime.retainedProjectionCount).toBe(1);
    runtime.dispose();
    expect(runtime.getProjection('cmd-1')).toBeUndefined();
  });

  it('updates terminal retention only for the delivered command instead of scanning every workflow', () => {
    const source = new FakeCommandEventSource();
    const workflows = new Map<string, CountingWorkflow>();
    const { runtime } = createFab({
      source,
      createWorkflow: (_targetFab, commandId) => {
        const workflow = new CountingWorkflow();
        workflows.set(commandId, workflow);
        return workflow;
      },
    });
    runtime.start();
    for (let index = 0; index < 40; index += 1) runtime.registerAcceptedCommand('cmd-' + index);
    runtime.registerAcceptedCommand('cmd-target');
    for (const workflow of workflows.values()) workflow.accesses = 0;
    source.emit(commandResult({ fabId, commandId: 'cmd-target', revision: 1, outcome: 'executing' }));
    const executingAccesses = [...workflows.values()].reduce((sum, workflow) => sum + workflow.accesses, 0);
    // Delivery now reads the projection before/after to decide whether the actor
    // accepted the revision for the ADR-010 acknowledge (no unrelated scan).
    expect(executingAccesses).toBeLessThanOrEqual(4);

    for (const workflow of workflows.values()) workflow.accesses = 0;
    source.emit(commandResult({ fabId, commandId: 'cmd-target', revision: 2, outcome: 'succeeded' }));
    const terminalAccesses = [...workflows.values()].reduce((sum, workflow) => sum + workflow.accesses, 0);
    expect(terminalAccesses).toBeLessThanOrEqual(4);
    expect(runtime.terminalWorkflowCount).toBe(1);
    expect(runtime.getProjection('cmd-target')).toMatchObject({ outcome: 'succeeded' });
  });

  it('bounds the correlation watermark registry without evicting active commands', async () => {
    const { CommandCorrelationRegistry } = await import('@/runtime/command-correlation-registry');
    let now = 0;
    const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 2, terminalTtlMs: 100, now: () => now });
    expect(registry.observe(commandResult({ fabId, commandId: 'active', revision: 1, outcome: 'executing' }))).toBe('new');
    registry.observe(commandResult({ fabId, commandId: 'done-1', revision: 2, outcome: 'succeeded' }));
    registry.observe(commandResult({ fabId, commandId: 'done-2', revision: 2, outcome: 'succeeded' }));
    registry.observe(commandResult({ fabId, commandId: 'done-3', revision: 2, outcome: 'succeeded' }));
    expect(registry.size).toBe(3);
    expect(registry.terminalCount).toBe(2);
    expect(registry.lastObservedRevision(fabId, 'active')).toBe(1);
    now = 1_000;
    expect(registry.sweep()).toBeGreaterThanOrEqual(2);
    expect(registry.lastObservedRevision(fabId, 'active')).toBe(1);
    expect(registry.lastObservedRevision(fabId, 'done-1')).toBeUndefined();
    expect(registry.size).toBe(1);
  });
});

describe('Round 5.1 post-snapshot recovery races (batch 2/3)', () => {
  it('never reports Healthy when a new recovery request arrives during the post-snapshot batch', async () => {
    const source = new FakeCommandEventSource();
    type ListMode = 'track' | 'block' | 'resolved';
    let listMode: ListMode = 'track';
    let blockedList!: (value: CommandRecoveryList) => void;
    let pauseStatus = false;
    let releaseStatus!: (value: CommandResultEvent) => void;
    const tracked = commandRecord({ fabId, commandId: 'cmd-1', revision: 1, outcome: 'executing' });
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        if (listMode === 'block') return new Promise<CommandRecoveryList>((resolve) => { blockedList = resolve; });
        return emptyRecoveryList([tracked]);
      },
      getCommandStatus: async (targetFab, commandId) => {
        if (pauseStatus && commandId === 'cmd-1') {
          pauseStatus = false;
          return new Promise<CommandResultEvent>((resolve) => { releaseStatus = resolve; });
        }
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway, recovery: { backoffMs: [1], maxAttempts: 8 } });
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    // First authoritative pass; its post-snapshot batch pauses on cmd-1.
    pauseStatus = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    await expect.poll(() => typeof releaseStatus, { timeout: 1_000 }).toBe('function');
    // A second recovery request arrives while the snapshot is already applied.
    source.emitDirty({ reason: 'overflow', droppedCount: 2 });
    await expect.poll(() => runtime.recoveryState.recoveryPending, { timeout: 1_000 }).toBe(true);

    // The first pass may not commit Healthy for the stale snapshot; the follow-up
    // List pass is observable and the runtime stays non-Healthy until it finishes.
    listMode = 'block';
    releaseStatus(commandResult({ fabId, commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
    await expect.poll(() => typeof blockedList, { timeout: 1_000 }).toBe('function');
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(runtime.lastRecoverySnapshot?.needsNextAuthoritativePass).toBe(true);

    listMode = 'resolved';
    blockedList(emptyRecoveryList([tracked]));
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.lastRecoverySnapshot?.needsNextAuthoritativePass).toBe(false);
  });

  it('compensates a drop observed during the post-snapshot batch before reporting Healthy', async () => {
    const source = new FakeCommandEventSource();
    let runtimeRef: FabRuntime | undefined;
    let listMode: 'track' | 'block' | 'resolved' = 'track';
    let blockedList!: (value: CommandRecoveryList) => void;
    let armed = false;
    let injected = false;
    const tracked = commandRecord({ fabId, commandId: 'cmd-1', revision: 1, outcome: 'executing' });
    const gateway = fakeCommandGateway({
      listFabCommands: async () => {
        if (listMode === 'block') return new Promise<CommandRecoveryList>((resolve) => { blockedList = resolve; });
        return emptyRecoveryList([tracked]);
      },
      getCommandStatus: async (targetFab, commandId) => {
        if (armed && !injected) {
          injected = true;
          // New commands registered while the snapshot is already authoritative
          // overflow the 1-slot scheduler queue: generation-stamped drop intents.
          // The compensation pass will need a List, so block it before it can run.
          listMode = 'block';
          queueMicrotask(() => {
            runtimeRef?.registerAcceptedCommand('late-1');
            runtimeRef?.registerAcceptedCommand('late-2');
          });
        }
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({
      source,
      gateway,
      maxConcurrentReconciliations: 1,
      maxQueuedReconciliations: 1,
      // A 50ms retry budget keeps the compensation pass observable after the drop;
      // the test never relies on a race between the timer and the List block.
      recovery: { backoffMs: [50], maxAttempts: 8, maxCompensationPasses: 2 },
    });
    runtimeRef = runtime;
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');

    armed = true;
    source.emitDirty({ reason: 'overflow', droppedCount: 1 });
    // The drop is recorded after the authoritative snapshot; the compensation pass
    // is then kept on a blocked List so the stale-snapshot gap is observable: the
    // runtime is not Healthy while authority is outstanding.
    await expect.poll(() => typeof blockedList, { timeout: 2_000 }).toBe('function');
    expect(runtime.pendingDropCount).toBeGreaterThan(0);
    expect(runtime.recoveryState.phase).not.toBe('Healthy');
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(true);

    listMode = 'resolved';
    blockedList(emptyRecoveryList([tracked]));
    await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
    expect(runtime.pendingDropCount).toBe(0);
    expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(false);
    expect(runtime.coveredDropCount).toBeGreaterThanOrEqual(1);
  });
});
