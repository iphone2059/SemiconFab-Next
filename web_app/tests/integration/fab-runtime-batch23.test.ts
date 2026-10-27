import { describe, expect, it } from 'vitest';
import type { CommandGateway } from '../../src/application/contracts/CommandGateway';
import type { CommandOutcome, CommandResultEvent } from '../../src/application/contracts/CommandEvents';
import type { CommandWorkflow, CommandWorkflowProjection } from '../../src/application/contracts/CommandWorkflow';
import { FabRuntimeFactory } from '../../src/runtime/FabRuntimeFactory';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes';

const fabId = 'fab-a';

function nonTerminalGateway(calls?: string[]): CommandGateway {
  return {
    getCommandStatus: async (targetFab, commandId) => {
      calls?.push(commandId);
      return commandResult({ fabId: targetFab, commandId, revision: 0, outcome: 'accepted' });
    },
  };
}

describe('FabRuntime replay-gap reconciliation (batch 2/3)', () => {
  it('coalesces a replay-gap/reconnect burst into one authoritative pass over active commands', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway: CommandGateway = {
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create(fabId);
    runtime.start();
    runtime.trackCommand('cmd-1');
    runtime.trackCommand('cmd-2');
    // Settle the submit-time reconciliation, then watch only the gap pass.
    await runtime.reconcileAll();
    calls.length = 0;

    source.emitGap();
    source.reconnect();
    source.emitGap();
    await expect.poll(() => calls.length, { timeout: 300 }).toBe(2);
    expect([...calls].sort()).toEqual(['cmd-1', 'cmd-2']);
    // No duplicate per-command queries from the same signal burst.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.length).toBe(2);
    runtime.dispose();
  });

  it('keeps gap-driven reconciliation isolated to the FAB whose stream gapped', async () => {
    const sourceA = new FakeCommandEventSource();
    const sourceB = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway: CommandGateway = {
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(`${targetFab}:${commandId}`);
        return commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    };
    const factory = new FabRuntimeFactory({ sourceFor: (targetFab) => targetFab === 'fab-a' ? sourceA : sourceB, gateway });
    const runtimeA = factory.create('fab-a');
    const runtimeB = factory.create('fab-b');
    runtimeA.start(); runtimeB.start();
    runtimeA.trackCommand('cmd');
    runtimeB.trackCommand('cmd');
    sourceA.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd', revision: 1, outcome: 'executing' }));
    sourceB.emit(commandResult({ fabId: 'fab-b', commandId: 'cmd', revision: 1, outcome: 'executing' }));
    await runtimeA.reconcileAll();
    await runtimeB.reconcileAll();
    calls.length = 0;

    // Each FabRuntime owns one FAB-scoped SSE source; a gap on A must never
    // reconcile B's commands (and vice versa).
    sourceA.emitGap();
    await expect.poll(() => calls.length, { timeout: 300 }).toBe(1);
    expect(calls).toEqual(['fab-a:cmd']);

    calls.length = 0;
    sourceB.emitGap();
    await expect.poll(() => calls.length, { timeout: 300 }).toBe(1);
    expect(calls).toEqual(['fab-b:cmd']);
    runtimeA.dispose(); runtimeB.dispose();
  });

  it('reconciles only tracked active commands; terminal and unknown ids are ignored', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const gateway: CommandGateway = {
      getCommandStatus: async (targetFab, commandId) => {
        calls.push(commandId);
        return commandId === 'done'
          ? commandResult({ fabId: targetFab, commandId, revision: 2, outcome: 'succeeded' })
          : commandResult({ fabId: targetFab, commandId, revision: 1, outcome: 'executing' });
      },
    };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create(fabId);
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
    runtime.dispose();
  });

  it('reconciles a command tracked after a replay gap when no local evidence exists', async () => {
    const source = new FakeCommandEventSource();
    const calls: string[] = [];
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway: nonTerminalGateway(calls) }).create(fabId);
    runtime.start();
    expect(runtime.hasLocalEvidence('cmd-1')).toBe(false);
    source.emitGap({ epoch: 'epoch-2', sequence: 4 });
    runtime.trackCommand('cmd-1');
    await expect.poll(() => calls.length, { timeout: 300 }).toBe(1);
    expect(calls[0]).toBe('cmd-1');
    // Local evidence is tracked from the same correlation watermark as delivery.
    source.emit(commandResult({ fabId, commandId: 'cmd-1', revision: 3, outcome: 'executing' }));
    expect(runtime.hasLocalEvidence('cmd-1')).toBe(true);
    runtime.dispose();
  });

  it('unsubscribes gap/reconnect signals on stop and dispose (CE-08)', () => {
    const source = new FakeCommandEventSource();
    const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create(fabId);
    runtime.start();
    expect(source.reconnectObservers).toBe(1);
    expect(source.gapObservers).toBe(1);
    expect(source.commandObservers).toBe(1);
    runtime.stop();
    expect(source.reconnectObservers).toBe(0);
    expect(source.gapObservers).toBe(0);
    expect(source.commandObservers).toBe(0);
    runtime.start();
    runtime.dispose();
    expect(source.reconnectObservers).toBe(0);
    expect(source.gapObservers).toBe(0);
    expect(source.commandObservers).toBe(0);
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
    const runtime = new FabRuntimeFactory({ sourceFor: () => new FakeCommandEventSource(), createWorkflow: () => {
      const workflow = new CountingWorkflow(); workflows.push(workflow); return workflow;
    } }).create(fabId);
    try {
      for (let index = 0; index < 100; index++) runtime.trackCommand('cmd-' + index);
      expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(200);
    } finally { runtime.dispose(); }
  });

  it('reconciles a batch with only linear projection visits and retains terminal outcomes', async () => {
    const workflows: CountingWorkflow[] = [];
    let outcome: CommandOutcome = 'executing';
    const runtime = new FabRuntimeFactory({ sourceFor: () => new FakeCommandEventSource(),
      gateway: { getCommandStatus: async (targetFab, commandId) => commandResult({ fabId: targetFab, commandId, revision: outcome === 'executing' ? 1 : 2, outcome }) },
      createWorkflow: () => { const workflow = new CountingWorkflow(); workflows.push(workflow); return workflow; },
    }).create(fabId);
    try {
      for (let index = 0; index < 40; index++) runtime.trackCommand('cmd-' + index);
      await runtime.reconcileAll();
      for (const workflow of workflows) workflow.accesses = 0;
      outcome = 'succeeded';
      await expect(runtime.reconcileAll()).resolves.toBe(40);
      expect(workflows.reduce((sum, workflow) => sum + workflow.accesses, 0)).toBeLessThanOrEqual(200);
      expect(runtime.terminalWorkflowCount).toBe(40);
      expect(runtime.getProjection('cmd-0')?.outcome).toBe('succeeded');
    } finally { runtime.dispose(); }
  });

  it('retains active workflows and evicts terminal workflows by max with a recent projection kept', () => {
    const source = new FakeCommandEventSource();
    const runtime = new FabRuntimeFactory({
      sourceFor: () => source,
      gateway: nonTerminalGateway(),
      retention: { terminalTtlMs: 60_000, maxTerminalWorkflows: 2, sweepIntervalMs: 1_000 },
    }).create(fabId);
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
    const runtime = new FabRuntimeFactory({
      sourceFor: () => source,
      gateway: nonTerminalGateway(),
      retention: { terminalTtlMs: 100, sweepIntervalMs: 5, now: () => now },
    }).create(fabId);
    runtime.start();
    runtime.trackCommand('cmd-1');
    source.emit(commandResult({ fabId, commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
    expect(runtime.workflowCount).toBe(1);
    now = 1_000;
    await expect.poll(() => runtime.workflowCount, { timeout: 300 }).toBe(0);
    expect(runtime.terminalWorkflowCount).toBe(0);
    expect(runtime.getProjection('cmd-1')).toMatchObject({ state: 'succeeded', outcome: 'succeeded' });
    expect(runtime.retainedProjectionCount).toBe(1);
    runtime.dispose();
    expect(runtime.getProjection('cmd-1')).toBeUndefined();
  });

  it('updates terminal retention only for the delivered command instead of scanning every workflow', () => {
    const source = new FakeCommandEventSource();
    const workflows = new Map<string, CountingWorkflow>();
    const runtime = new FabRuntimeFactory({
      sourceFor: () => source,
      createWorkflow: (_fabId, commandId) => {
        const workflow = new CountingWorkflow();
        workflows.set(commandId, workflow);
        return workflow;
      },
    }).create(fabId);
    runtime.start();
    for (let index = 0; index < 40; index += 1) runtime.trackCommand('cmd-' + index);
    runtime.trackCommand('cmd-target');
    // The eventless assembly path (trackCommand) may sweep once; deliveries must not.
    for (const workflow of workflows.values()) workflow.accesses = 0;
    source.emit(commandResult({ fabId, commandId: 'cmd-target', revision: 1, outcome: 'executing' }));
    const executingAccesses = [...workflows.values()].reduce((sum, workflow) => sum + workflow.accesses, 0);
    // The audited implementation walked every workflow projection per delivery (41 here).
    expect(executingAccesses).toBeLessThanOrEqual(2);

    for (const workflow of workflows.values()) workflow.accesses = 0;
    source.emit(commandResult({ fabId, commandId: 'cmd-target', revision: 2, outcome: 'succeeded' }));
    const terminalAccesses = [...workflows.values()].reduce((sum, workflow) => sum + workflow.accesses, 0);
    expect(terminalAccesses).toBeLessThanOrEqual(2);
    expect(runtime.terminalWorkflowCount).toBe(1);
    expect(runtime.getProjection('cmd-target')).toMatchObject({ outcome: 'succeeded' });
    runtime.dispose();
  });

  it('bounds the correlation watermark registry without evicting active commands', async () => {
    const { CommandCorrelationRegistry } = await import('../../src/application/coordination/CommandCorrelationRegistry');
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
