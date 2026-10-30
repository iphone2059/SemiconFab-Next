import { afterEach, describe, expect, it } from 'vitest';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import type { TestFab, TestFabOptions } from '../support/command-fakes.ts';
import {
  CountingCommandWorkflow,
  FakeCommandEventSource,
  commandResult,
  createTestFab,
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
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand('cmd-1');
    runtime.trackCommand('cmd-2');
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
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(targetFab + ':' + commandId);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const previous = createFab({ source: oldSource, gateway });
    previous.runtime.start();
    previous.runtime.trackCommand('cmd');
    await previous.runtime.reconcileAll();
    previous.runtime.dispose();
    const current = createFab({ source: currentSource, gateway });
    current.runtime.start();
    current.runtime.trackCommand('cmd');
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
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandId === 'done'
          ? commandResult({ fabId: targetFab, commandId, revision: 2, outcome: 'succeeded' })
          : commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand('active');
    source.emit(commandResult({ fabId, commandId: 'active', revision: 1, outcome: 'executing' }));
    runtime.trackCommand('done');
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
    runtime.trackCommand('cmd-1');
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
  accesses = 0;
  private revisionValue = -1;
  private outcomeValue: CommandOutcome | 'pending' = 'pending';

  receive(event: CommandResultEvent): void {
    if (event.revision <= this.revisionValue) return;
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
    };
  }
}

describe('FabRuntime bounded workflow/correlation retention (batch 2/3)', () => {
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
    for (let index = 0; index < 100; index++) fab.runtime.trackCommand('cmd-' + index);
    // A registration change projects only the new command: O(1) per registration,
    // never a scan over every earlier workflow (the audited path was O(N) per track).
    expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(workflows.length * 8);
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
    for (let index = 0; index < 40; index++) runtime.trackCommand('cmd-' + index);
    await runtime.reconcileAll();
    for (const workflow of workflows) workflow.accesses = 0;
    outcome = 'succeeded';
    await expect(runtime.reconcileAll()).resolves.toBe(40);
    expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(workflows.length * 8);
    expect(runtime.terminalWorkflowCount).toBe(40);
    expect(runtime.getProjection('cmd-0')?.outcome).toBe('succeeded');
  });

  it('retains active workflows and evicts terminal workflows by max with a recent projection kept', () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({
      source,
      gateway: nonTerminalGateway(),
      createWorkflow: (targetFab, commandId) => new CountingCommandWorkflow(targetFab, commandId),
      retention: { terminalTtlMs: 60_000, maxTerminalWorkflows: 2, sweepIntervalMs: 1_000 },
    });
    runtime.start();
    runtime.trackCommand('active');
    source.emit(commandResult({ fabId, commandId: 'active', revision: 1, outcome: 'accepted' }));
    for (const commandId of ['done-1', 'done-2', 'done-3']) {
      runtime.trackCommand(commandId);
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
      retention: { terminalTtlMs: 100, sweepIntervalMs: 5, now: () => now },
    });
    runtime.start();
    runtime.trackCommand('cmd-1');
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
    for (let index = 0; index < 40; index += 1) runtime.trackCommand('cmd-' + index);
    runtime.trackCommand('cmd-target');
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
    expect(registry.lastRevision(fabId, 'active')).toBe(1);
    now = 1_000;
    expect(registry.sweep()).toBeGreaterThanOrEqual(2);
    expect(registry.lastRevision(fabId, 'active')).toBe(1);
    expect(registry.lastRevision(fabId, 'done-1')).toBeUndefined();
    expect(registry.size).toBe(1);
  });
});
