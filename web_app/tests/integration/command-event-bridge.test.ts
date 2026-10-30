import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type {
  CommandWorkflow,
  CommandWorkflowProjection,
  CommandWorkflowRegistry,
} from '@/contracts/command-workflow.contract';
import {
  type CommandTestRuntime,
  FakeCommandEventSource,
  FakeCommandWorkflow,
  FakeWorkflowRegistry,
  commandResult,
  createCommandTestRuntime,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabId = 'fab-a';
const commandId = 'cmd-1';

interface SetupOptions {
  readonly fabId?: string;
  /** Registry override (defect-injection tests); defaults to a FakeWorkflowRegistry. */
  readonly workflows?: CommandWorkflowRegistry;
  readonly onRejected?: (event: CommandResultEvent) => void;
  readonly onDefect?: (cause: unknown) => void;
  readonly onConsumerExit?: (exit: Exit.Exit<void, never>) => void;
}

interface Setup {
  readonly source: FakeCommandEventSource;
  readonly workflows: FakeWorkflowRegistry;
  readonly registry: CommandWorkflowRegistry;
  readonly workflow: FakeCommandWorkflow;
  readonly bridge: CommandEventBridge;
  readonly harness: CommandTestRuntime;
  readonly scope: Scope.Closeable;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(options: SetupOptions = {}): Setup {
  const source = new FakeCommandEventSource();
  const workflows = new FakeWorkflowRegistry();
  const registry = options.workflows ?? workflows;
  const workflow = new FakeCommandWorkflow();
  const harness = createCommandTestRuntime();
  const scope = Scope.makeUnsafe();
  const bridge = new CommandEventBridge(source, registry, {
    ...(options.fabId !== undefined ? { fabId: options.fabId } : {}),
    ...(options.onRejected !== undefined ? { onRejected: options.onRejected } : {}),
    ...(options.onDefect !== undefined ? { onDefect: options.onDefect } : {}),
    ...(options.onConsumerExit !== undefined ? { onConsumerExit: options.onConsumerExit } : {}),
    runtime: harness.host,
    scope,
  });
  cleanups.push(async () => {
    bridge.dispose();
    harness.host.runSync(Scope.close(scope, Exit.void));
    await harness.dispose();
  });
  return { source, workflows, registry, workflow, bridge, harness, scope };
}

/** Workflow that proves application through a projection (production XState shape). */
class ProjectionWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];
  receiveCalls = 0;
  private revisionValue = -1;
  private outcomeValue: CommandWorkflowProjection['outcome'] = 'pending';

  receive(event: CommandResultEvent): void {
    this.receiveCalls += 1;
    if (event.revision <= this.revisionValue) return;
    this.events.push(event);
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return {
      state: this.outcomeValue === 'pending' ? 'idle' : this.outcomeValue,
      revision: this.revisionValue,
      outcome: this.outcomeValue,
    };
  }
}

/** Projection that never advances: the actor rejects every revision (terminal/stale). */
class RejectingWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];

  receive(event: CommandResultEvent): void {
    this.events.push(event);
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return { state: 'terminal', revision: 0, outcome: 'succeeded' };
  }
}

describe('CommandEventBridge (CE-01..CE-05)', () => {
  it('CE-01 delivers accepted/executing/succeeded in order to the registered workflow', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    for (const [revision, outcome] of [[1, 'accepted'], [2, 'executing'], [3, 'succeeded']] as const) {
      source.emit(commandResult({ fabId, commandId, revision, outcome }));
    }
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([
      [1, 'accepted'],
      [2, 'executing'],
      [3, 'succeeded'],
    ]);
    expect(bridge.pendingCount).toBe(0);
  });

  it('CE-02 filters a duplicate revision without advancing the workflow twice', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' });
    source.emit(event);
    source.emit({ ...event, outcome: 'succeeded' });
    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0].outcome).toBe('accepted');
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(1);
  });

  it('CE-03 ignores an out-of-order revision and never regresses state', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    expect(workflow.events.map((event) => event.revision)).toEqual([2]);
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(2);
  });

  it('CE-04 keeps a confirmation that arrives before the HTTP response and correlates it later', () => {
    const { source, workflows, workflow, bridge } = setup();
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'succeeded' }));
    expect(workflow.events).toHaveLength(0);
    expect(bridge.pendingCount).toBe(1);
    workflows.register(fabId, commandId, workflow);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([[1, 'succeeded']]);
    expect(bridge.pendingCount).toBe(0);
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'cancelled' }));
    expect(workflow.events).toHaveLength(2);
  });

  it('CE-05 recovers an unknown actor through the authoritative command gateway', async () => {
    const { source, workflows, workflow, bridge } = setup();
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    expect(bridge.pendingCount).toBe(1);

    const gateway: CommandGateway = fakeCommandGateway({
      getCommandStatus: async () => commandResult({ fabId, commandId, revision: 3, outcome: 'succeeded' }),
    });
    workflows.register(fabId, commandId, workflow);
    await expect(bridge.reconcile(gateway, fabId, commandId, (effect) => Effect.runPromise(effect))).resolves.toBe(2);
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([
      [2, 'executing'],
      [3, 'succeeded'],
    ]);
    expect(bridge.pendingCount).toBe(0);
  });

  it('filters events from another FAB by composite identity', () => {
    const { source, workflows, workflow, bridge } = setup({ fabId: 'fab-b' });
    workflows.register('fab-b', commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    source.emit(commandResult({ fabId: 'fab-b', commandId, revision: 1, outcome: 'accepted' }));
    expect(workflow.events.map((event) => event.fabId)).toEqual(['fab-b']);
  });
});

describe('CommandEventBridge lifecycle (CE-08)', () => {
  it('stops delivering after start/stop and clears pending recovery state', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    bridge.stop();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }));
    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0].revision).toBe(1);
    expect(bridge.running).toBe(false);

    source.emit(commandResult({ fabId: 'fab-a', commandId: 'unknown', revision: 1, outcome: 'failed' }));
    expect(bridge.pendingCount).toBe(0);
    bridge.dispose();
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('R4-03 observed/applied split and authoritative receive', () => {
  it('receive returns explicit outcomes: held, duplicate-applied, stale-covered, ignored', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' });
    // Missing workflow => held in the bounded recovery queue, never dropped.
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(1);
    // Observed is not applied.
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();

    const projected = new ProjectionWorkflow();
    workflows.register(fabId, commandId, projected);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(1);
    // Duplicate of an applied revision: already covered by the actor projection.
    expect(bridge.receive(event)).toBe('duplicate-applied');
    expect(projected.events).toHaveLength(1);
    // Older revision: covered by the observed watermark.
    expect(bridge.receive(commandResult({ fabId, commandId, revision: 0, outcome: 'accepted' }))).toBe('stale-covered');
    // Foreign FAB identity is ignored before any watermark bookkeeping.
    expect(bridge.receive(commandResult({ fabId: 'fab-b', commandId, revision: 1, outcome: 'accepted' }))).toBe('ignored');
  });

  it('a duplicate that was observed but never applied is rejected, not duplicate-applied', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = commandResult({ fabId, commandId, revision: 2, outcome: 'executing' });
    expect(bridge.receive(event)).toBe('held');
    // No workflow => the revision was observed but never applied.
    expect(bridge.receive(event)).toBe('rejected');
    const projected = new ProjectionWorkflow();
    workflows.register(fabId, commandId, projected);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(2);
    expect(bridge.receive(event)).toBe('duplicate-applied');
  });

  it('receiveAuthoritative bypasses the observed-revision duplicate gate and re-delivers', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = commandResult({ fabId, commandId, revision: 3, outcome: 'executing' });
    // SSE observed the revision while no workflow existed: observed, not applied.
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(3);
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();

    const projected = new ProjectionWorkflow();
    workflows.register(fabId, commandId, projected);
    // The realtime path still refuses the duplicate (actor has not applied it) ...
    expect(bridge.receive(event)).toBe('rejected');
    expect(projected.events).toHaveLength(0);
    // ... but an authoritative snapshot must be able to re-apply the same revision.
    expect(bridge.receiveAuthoritative(event, 3)).toBe('applied');
    expect(projected.events.map((result) => result.revision)).toEqual([3]);
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(3);
    // Actor already at/past the revision => stale-covered, still re-delivered to
    // the actor (the projection itself ignores the non-advancing revision).
    expect(bridge.receiveAuthoritative(event, 3)).toBe('stale-covered');
    expect(projected.receiveCalls).toBe(2);
    expect(projected.events).toHaveLength(1);
  });

  it('an unverifiable workflow only trusts authoritative coverage', () => {
    const { workflows, workflow, bridge } = setup({ fabId });
    workflows.register(fabId, commandId, workflow);
    const event = commandResult({ fabId, commandId, revision: 4, outcome: 'succeeded' });
    // No projection => delivery is optimistic for realtime but can never be proven.
    expect(bridge.receive(event)).toBe('applied');
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();
    // No cover supplied: the authoritative path refuses to claim application.
    expect(bridge.receiveAuthoritative(event)).toBe('rejected');
    // Covered by the authoritative snapshot revision: trusted.
    expect(bridge.receiveAuthoritative(event, 4)).toBe('applied');
    expect(workflow.events.map((result) => result.revision)).toEqual([4, 4, 4]);
  });

  it('flushRecovery re-holds rejected events, reports them, and never drain-and-drops', () => {
    const rejected: CommandResultEvent[] = [];
    const { workflows, bridge } = setup({ fabId, onRejected: (event) => rejected.push(event) });
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'executing' });
    expect(bridge.receive(event)).toBe('held');

    const rejecting = new RejectingWorkflow();
    workflows.register(fabId, commandId, rejecting);
    expect(bridge.flushRecovery()).toEqual({ applied: 0, held: 0, rejected: 1 });
    expect(rejected).toEqual([event]);
    // The rejected event stays held for the next authoritative pass.
    expect(bridge.pendingCount).toBe(1);
    expect(rejecting.events).toHaveLength(1);
  });

  it('flushRecovery keeps uncorrelated events held instead of draining them', () => {
    const { bridge } = setup({ fabId });
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'succeeded' });
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.flushRecovery()).toEqual({ applied: 0, held: 1, rejected: 0 });
    expect(bridge.pendingCount).toBe(1);
  });
});

describe('R4-05 consumer fiber observation', () => {
  it('an unexpected consumer exit resets started before onConsumerExit and is restartable', async () => {
    const exits: Array<Exit.Exit<void, never>> = [];
    const { source, bridge } = setup({ onConsumerExit: (exit) => exits.push(exit) });
    bridge.start();
    expect(bridge.running).toBe(true);
    // The stream ends on its own (PubSub shutdown): an unexpected fiber termination.
    source.complete();
    await expect.poll(() => exits.length, { timeout: 1_000 }).toBe(1);
    expect(Exit.isSuccess(exits[0]!)).toBe(true);
    // Contract: started/commandFiber were reset before the owner callback ran.
    expect(bridge.running).toBe(false);
    // The owner can re-arm the consumer after an unexpected exit (here the old
    // PubSub is already shut down, so the re-armed consumer exits again at once;
    // the point is that restart re-arms rather than observing started=true forever).
    bridge.restart();
  });

  it('stop() is an expected exit and never calls onConsumerExit', async () => {
    const exits: Array<Exit.Exit<void, never>> = [];
    const { bridge } = setup({ onConsumerExit: (exit) => exits.push(exit) });
    bridge.start();
    bridge.stop();
    expect(bridge.running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toHaveLength(0);
  });

  it('a consumer handler defect is reported through onDefect without killing the fiber (R4-05b)', async () => {
    const defects: unknown[] = [];
    const throwing: CommandWorkflowRegistry = {
      get() {
        throw new Error('handler exploded');
      },
    };
    const { source, bridge } = setup({ workflows: throwing, onDefect: (cause) => defects.push(cause) });
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    await expect.poll(() => defects.length, { timeout: 1_000 }).toBe(2);
    expect(defects[0]).toBeInstanceOf(Error);
    // The consumer survives the defect: no silent fiber death, no Dirty restart storm.
    expect(bridge.running).toBe(true);
  });
});
