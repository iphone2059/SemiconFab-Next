import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
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
  commandCursor,
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
  readonly onConflict?: (event: CommandResultEvent) => void;
  readonly onUncorrelated?: (event: CommandResultEvent) => void;
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
    ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
    ...(options.onUncorrelated !== undefined ? { onUncorrelated: options.onUncorrelated } : {}),
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

const result = (revision: number, outcome: CommandOutcome): CommandResultEvent =>
  commandResult({ fabId, commandId, revision, outcome });

/**
 * Workflow that models the production terminal rule: realtime may never revive or
 * correct a terminal projection, authoritative may correct it in place (P1-03).
 */
class TerminalWorkflow implements CommandWorkflow {
  readonly realtimeEvents: CommandResultEvent[] = [];
  readonly authoritativeEvents: CommandResultEvent[] = [];
  readonly events: CommandResultEvent[] = [];
  private revisionValue = -1;
  private outcomeValue: CommandOutcome | 'pending' = 'pending';

  receiveRealtime(event: CommandResultEvent): void {
    this.realtimeEvents.push(event);
    if (this.terminal()) return;
    if (event.revision <= this.revisionValue) return;
    this.apply(event);
  }

  receiveAuthoritative(event: CommandResultEvent): void {
    this.authoritativeEvents.push(event);
    if (event.revision < this.revisionValue) return;
    if (event.revision === this.revisionValue && event.outcome === this.outcomeValue) return;
    this.apply(event);
  }

  markExpiredUnresolved(): void {}

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return {
      state: this.expiredState ? 'expired' : this.outcomeValue === 'pending' ? 'idle' : this.outcomeValue,
      revision: this.revisionValue,
      outcome: this.outcomeValue,
      recoveryDisposition: this.expiredState ? 'expired-unresolved' : 'tracked',
    };
  }

  private expiredState = false;

  private terminal(): boolean {
    return this.outcomeValue === 'succeeded' || this.outcomeValue === 'failed' || this.outcomeValue === 'cancelled';
  }

  private apply(event: CommandResultEvent): void {
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
    this.events.push(event);
  }
}

/** Projection that never advances: the actor rejects every revision (terminal/stale). */
class RejectingWorkflow implements CommandWorkflow {
  readonly realtimeEvents: CommandResultEvent[] = [];
  readonly authoritativeEvents: CommandResultEvent[] = [];
  readonly events: CommandResultEvent[] = [];

  receiveRealtime(event: CommandResultEvent): void {
    this.events.push(event);
    this.realtimeEvents.push(event);
  }

  receiveAuthoritative(event: CommandResultEvent): void {
    this.events.push(event);
    this.authoritativeEvents.push(event);
  }

  markExpiredUnresolved(): void {}

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return { state: 'terminal', revision: 0, outcome: 'succeeded', recoveryDisposition: 'tracked' };
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
    expect(bridge.conflictCount).toBe(0);
    expect(source.cursors.acknowledged).toBeDefined();
    expect(source.cursors.pendingAcknowledgements).toBe(0);
  });

  it('CE-02 filters a duplicate same-outcome revision without advancing the workflow twice', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' });
    source.emit(event);
    source.emit({ ...event });
    expect(workflow.events).toHaveLength(1);
    expect(workflow.realtimeEvents).toHaveLength(1);
    expect(workflow.events[0].outcome).toBe('accepted');
    expect(bridge.correlationRegistry.lastObservedRevision(fabId, commandId)).toBe(1);
    // A same-outcome duplicate is not a conflict.
    expect(bridge.conflictCount).toBe(0);
    expect(bridge.pendingCount).toBe(0);
  });

  it('CE-03 ignores an out-of-order revision and never regresses state', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    expect(workflow.events.map((event) => event.revision)).toEqual([2]);
    expect(bridge.correlationRegistry.lastObservedRevision(fabId, commandId)).toBe(2);
    expect(bridge.correlationRegistry.lastObservedOutcome(fabId, commandId)).toBe('executing');
  });

  it('CE-04 keeps a confirmation that arrives before the HTTP response and correlates it later', () => {
    const { source, workflows, workflow, bridge } = setup();
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'succeeded' }));
    expect(workflow.realtimeEvents).toHaveLength(0);
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
    expect(bridge.conflictCount).toBe(0);
  });
});

describe('R4-03 observed/applied split and authoritative receive', () => {
  it('receive returns explicit outcomes: held, duplicate-applied, stale-covered, ignored', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = result(1, 'accepted');
    // Missing workflow => held in the bounded recovery queue, never dropped.
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.correlationRegistry.lastObservedRevision(fabId, commandId)).toBe(1);
    // Observed is not applied.
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();

    const projected = new FakeCommandWorkflow();
    workflows.register(fabId, commandId, projected);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(1);
    // Duplicate of an applied revision: already covered by the actor projection.
    expect(bridge.receive(event)).toBe('duplicate-applied');
    expect(projected.events).toHaveLength(1);
    // Older revision: covered by the observed watermark.
    expect(bridge.receive(result(0, 'accepted'))).toBe('stale-covered');
    // Foreign FAB identity is ignored before any watermark bookkeeping.
    expect(bridge.receive(commandResult({ fabId: 'fab-b', commandId, revision: 1, outcome: 'accepted' }))).toBe('ignored');
  });

  it('a duplicate that was observed but never applied is rejected, not duplicate-applied', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = result(2, 'executing');
    expect(bridge.receive(event)).toBe('held');
    // No workflow => the revision was observed but never applied.
    expect(bridge.receive(event)).toBe('held');
    const projected = new FakeCommandWorkflow();
    workflows.register(fabId, commandId, projected);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(2);
    expect(bridge.receive(event)).toBe('duplicate-applied');
  });

  it('receiveAuthoritative bypasses the observed-revision duplicate gate and re-delivers', () => {
    const { workflows, bridge } = setup({ fabId });
    const event = result(3, 'executing');
    // SSE observed the revision while no workflow existed: observed, not applied.
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.correlationRegistry.lastObservedRevision(fabId, commandId)).toBe(3);
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();

    const projected = new FakeCommandWorkflow();
    workflows.register(fabId, commandId, projected);
    // An authoritative snapshot must be able to apply the observed revision.
    expect(bridge.receiveAuthoritative(event, 3)).toBe('applied');
    expect(projected.authoritativeEvents.map((result) => result.revision)).toEqual([3]);
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(3);
    // Actor already at/past the revision => stale-covered, still re-delivered to
    // the actor (the projection itself ignores the non-advancing revision).
    expect(bridge.receiveAuthoritative(event, 3)).toBe('stale-covered');
    expect(projected.authoritativeEvents).toHaveLength(2);
    expect(projected.events).toHaveLength(1);
  });

  it('an unverifiable workflow cannot prove either realtime or authoritative application', () => {
    const { workflows, bridge } = setup({ fabId });
    const events: CommandResultEvent[] = [];
    const workflow: CommandWorkflow = {
      receiveRealtime: (event) => { events.push(event); },
      receiveAuthoritative: (event) => { events.push(event); },
      markExpiredUnresolved() {},
      async reconcile() {},
      dispose() {},
    };
    workflows.register(fabId, commandId, workflow);
    const event = result(4, 'succeeded');
    // No projection => delivery can never be proven.
    expect(bridge.receive(event)).toBe('rejected');
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();
    // No cover supplied: the authoritative path refuses to claim application too.
    expect(bridge.receiveAuthoritative(event)).toBe('rejected');
    expect(bridge.receiveAuthoritative(event, 4)).toBe('rejected');
    expect(events.map((result) => result.revision)).toEqual([4, 4, 4]);
  });

  it('flushRecovery re-holds rejected events, reports them, and never drain-and-drops', () => {
    const rejected: CommandResultEvent[] = [];
    const { workflows, bridge } = setup({ fabId, onRejected: (event) => rejected.push(event) });
    const event = result(1, 'executing');
    expect(bridge.receive(event)).toBe('held');

    const rejecting = new RejectingWorkflow();
    workflows.register(fabId, commandId, rejecting);
    expect(bridge.flushRecovery()).toEqual({ applied: 0, held: 0, rejected: 1 });
    expect(rejected).toEqual([event]);
    // The rejected event stays held for the next authoritative pass.
    expect(bridge.pendingCount).toBe(1);
    expect(rejecting.realtimeEvents).toHaveLength(1);
  });

  it('flushRecovery keeps uncorrelated events held instead of draining them', () => {
    const { bridge } = setup({ fabId });
    const event = result(1, 'succeeded');
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.flushRecovery()).toEqual({ applied: 0, held: 1, rejected: 0 });
    expect(bridge.pendingCount).toBe(1);
  });
});

describe('Round 5.1 / P1-02 uncorrelated and conflict handling', () => {
  it('holds an uncorrelated event, reports it, and never ACKs it', () => {
    const uncorrelated: CommandResultEvent[] = [];
    const { source, workflows, bridge, workflow } = setup({ fabId, onUncorrelated: (event) => uncorrelated.push(event) });
    const event = result(1, 'succeeded');
    const cursor = commandCursor('epoch-1', 1);
    source.deliverUnprocessed(event, cursor);
    expect(bridge.receive(event)).toBe('held');
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.conflictCount).toBe(0);
    expect(uncorrelated).toEqual([event]);
    // The event was delivered but nothing applied it: no ACK, ledger entry stays.
    expect(source.cursors.acknowledged).toBeUndefined();
    expect(source.pendingAcknowledgementCount).toBe(1);
    // Once the workflow exists, the retry applies the SAME realtime event and ACKs.
    workflows.register(fabId, commandId, workflow);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(workflow.realtimeEvents).toEqual([event]);
    expect(workflow.authoritativeEvents).toEqual([]);
    expect(source.pendingAcknowledgementCount).toBe(0);
    expect(source.cursors.acknowledged).toEqual(cursor);
  });

  it('reports a same-revision outcome conflict, never ACKs or re-delivers it, and clears it via authority', () => {
    const conflicts: CommandResultEvent[] = [];
    const { source, workflows, bridge, workflow } = setup({ fabId, onConflict: (event) => conflicts.push(event) });
    workflows.register(fabId, commandId, workflow);
    const accepted = result(3, 'accepted');
    const failed = result(3, 'failed');
    const firstCursor = commandCursor('epoch-1', 1);
    const conflictCursor = commandCursor('epoch-1', 2);

    source.deliverUnprocessed(accepted, firstCursor);
    expect(bridge.receive(accepted)).toBe('applied');
    expect(source.cursors.acknowledged).toEqual(firstCursor);
    expect(bridge.pendingCount).toBe(0);

    // Same revision, different outcome: protocol conflict, not a duplicate.
    source.deliverUnprocessed(failed, conflictCursor);
    expect(bridge.receive(failed)).toBe('conflict');
    expect(conflicts).toEqual([failed]);
    expect(bridge.conflictCount).toBe(1);
    // pendingCount includes unresolved conflicts (the Healthy barrier sees it).
    expect(bridge.pendingCount).toBe(1);
    // NO ACK, even though appliedRevision >= revision: the ledger entry stays pending.
    expect(source.cursors.acknowledged).toEqual(firstCursor);
    expect(source.pendingAcknowledgementCount).toBe(1);
    // The conflicting event is never delivered to the workflow.
    expect(workflow.realtimeEvents).toHaveLength(1);
    expect(workflow.events).toHaveLength(1);
    // Repeating the same conflicting frame cannot grow the conflict set.
    expect(bridge.receive(failed)).toBe('conflict');
    expect(bridge.conflictCount).toBe(1);
    expect(conflicts).toHaveLength(2);

    // Authority corrects the same-revision outcome: projection repaired, conflict
    // resolved, and only then is the previously-conflicting ledger entry ACKed.
    expect(bridge.receiveAuthoritative(failed)).toBe('stale-covered');
    expect(workflow.authoritativeEvents).toEqual([failed]);
    expect(workflow.events).toHaveLength(2);
    expect(workflow.projection.revision).toBe(3);
    expect(workflow.projection.outcome).toBe('failed');
    expect(bridge.conflictCount).toBe(0);
    expect(bridge.pendingCount).toBe(0);
    expect(source.cursors.acknowledged).toEqual(conflictCursor);
    expect(bridge.correlationRegistry.lastObservedOutcome(fabId, commandId)).toBe('failed');
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(3);
  });

  it('resolves a conflict below a higher authoritative revision and converges the projection', () => {
    const { workflows, bridge, workflow } = setup({ fabId });
    workflows.register(fabId, commandId, workflow);
    expect(bridge.receive(result(3, 'accepted'))).toBe('applied');
    expect(bridge.receive(result(3, 'failed'))).toBe('conflict');
    expect(bridge.conflictCount).toBe(1);
    // Authority reports a newer revision: it supersedes the conflicting revision.
    expect(bridge.receiveAuthoritative(result(4, 'succeeded'))).toBe('applied');
    expect(workflow.projection.revision).toBe(4);
    expect(workflow.projection.outcome).toBe('succeeded');
    expect(bridge.conflictCount).toBe(0);
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.correlationRegistry.lastObservedOutcome(fabId, commandId)).toBe('succeeded');
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(4);
  });

  it('an authoritative snapshot can correct a wrong terminal projection at the same revision', () => {
    const { workflows, bridge } = setup({ fabId });
    const terminal = new TerminalWorkflow();
    workflows.register(fabId, commandId, terminal);
    expect(bridge.receive(result(3, 'succeeded'))).toBe('applied');
    expect(terminal.projection.outcome).toBe('succeeded');
    // A terminal projection may never be corrected by realtime: it is a conflict.
    expect(bridge.receive(result(3, 'failed'))).toBe('conflict');
    expect(bridge.conflictCount).toBe(1);
    expect(terminal.realtimeEvents).toHaveLength(1);
    // Authority may correct the terminal projection in place (P1-03).
    expect(bridge.receiveAuthoritative(result(3, 'failed'))).toBe('stale-covered');
    expect(terminal.authoritativeEvents).toEqual([result(3, 'failed')]);
    expect(terminal.projection.revision).toBe(3);
    expect(terminal.projection.outcome).toBe('failed');
    expect(bridge.conflictCount).toBe(0);
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(3);
  });

  it('an authoritative lower revision is stale and never rolls the projection back', () => {
    const { workflows, bridge, workflow } = setup({ fabId });
    workflows.register(fabId, commandId, workflow);
    expect(bridge.receive(result(5, 'succeeded'))).toBe('applied');
    expect(bridge.receiveAuthoritative(result(3, 'failed'))).toBe('stale-covered');
    expect(workflow.projection.revision).toBe(5);
    expect(workflow.projection.outcome).toBe('succeeded');
    expect(bridge.correlationRegistry.lastObservedRevision(fabId, commandId)).toBe(5);
    expect(bridge.correlationRegistry.lastObservedOutcome(fabId, commandId)).toBe('succeeded');
    expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBe(5);
  });

  it('receiveAuthoritative holds a missing workflow once without an uncorrelated signal', () => {
    const uncorrelated: CommandResultEvent[] = [];
    const { bridge } = setup({ fabId, onUncorrelated: (event) => uncorrelated.push(event) });
    expect(bridge.receiveAuthoritative(result(5, 'succeeded'))).toBe('held');
    expect(bridge.pendingCount).toBe(1);
    expect(uncorrelated).toEqual([]);
  });

  it('holds and reports an authoritative event rejected by the actor projection', () => {
    const rejected: CommandResultEvent[] = [];
    const { workflows, bridge } = setup({ fabId, onRejected: (event) => rejected.push(event) });
    workflows.register(fabId, commandId, new RejectingWorkflow());
    const event = result(1, 'executing');
    expect(bridge.receiveAuthoritative(event)).toBe('rejected');
    expect(rejected).toEqual([event]);
    // Never silently dropped: it stays in the bounded recovery queue for retry.
    expect(bridge.pendingCount).toBe(1);
  });

  it('flushRecovery applies held realtime events and leaves conflicts untouched', () => {
    const { workflows, bridge } = setup({ fabId });
    const conflictCommandId = 'conflict-cmd';
    const conflictWorkflow = new FakeCommandWorkflow();
    workflows.register(fabId, conflictCommandId, conflictWorkflow);
    // One held SSE event with no workflow yet.
    const held = commandResult({ fabId, commandId: 'held-cmd', revision: 2, outcome: 'executing' });
    expect(bridge.receive(held)).toBe('held');
    // One unresolved conflict on another command (already applied revision 3 accepted).
    expect(bridge.receive(commandResult({ fabId, commandId: conflictCommandId, revision: 3, outcome: 'accepted' }))).toBe('applied');
    expect(bridge.receive(commandResult({ fabId, commandId: conflictCommandId, revision: 3, outcome: 'failed' }))).toBe('conflict');
    expect(bridge.pendingCount).toBe(2);
    expect(bridge.conflictCount).toBe(1);
    // Nothing to apply: the held event's workflow is still missing, conflict untouched.
    expect(bridge.flushRecovery()).toEqual({ applied: 0, held: 1, rejected: 0 });
    expect(bridge.pendingCount).toBe(2);
    expect(bridge.conflictCount).toBe(1);
    // Once the workflow exists the held event applies; the conflict is NOT flushed.
    const heldWorkflow = new FakeCommandWorkflow();
    workflows.register(fabId, 'held-cmd', heldWorkflow);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(heldWorkflow.realtimeEvents).toEqual([held]);
    expect(heldWorkflow.authoritativeEvents).toEqual([]);
    expect(bridge.conflictCount).toBe(1);
    expect(bridge.pendingCount).toBe(1);
    // Only authority clears the conflict.
    expect(bridge.receiveAuthoritative(commandResult({ fabId, commandId: conflictCommandId, revision: 3, outcome: 'failed' }))).toBe('stale-covered');
    expect(bridge.conflictCount).toBe(0);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('Round 5.1 / P1-03 realtime vs authoritative channel routing', () => {
  it('routes each channel to its contract method and records the split', () => {
    const { workflows, bridge, workflow } = setup({ fabId });
    workflows.register(fabId, commandId, workflow);
    expect(bridge.receive(result(1, 'executing'))).toBe('applied');
    expect(workflow.realtimeEvents.map((event) => event.revision)).toEqual([1]);
    expect(workflow.authoritativeEvents).toEqual([]);
    expect(bridge.receiveAuthoritative(result(2, 'succeeded'))).toBe('applied');
    expect(workflow.authoritativeEvents.map((event) => event.revision)).toEqual([2]);
    expect(workflow.realtimeEvents.map((event) => event.revision)).toEqual([1]);
    expect(workflow.events.map((event) => event.revision)).toEqual([1, 2]);
  });

  it('flushRecovery retries queued SSE events as realtime, never as authoritative', () => {
    const { workflows, bridge, workflow } = setup({ fabId });
    // No workflow yet: the SSE frame is queued as a realtime event.
    expect(bridge.receive(result(2, 'executing'))).toBe('held');
    workflows.register(fabId, commandId, workflow);
    expect(bridge.flushRecovery()).toEqual({ applied: 1, held: 0, rejected: 0 });
    expect(workflow.realtimeEvents.map((event) => event.revision)).toEqual([2]);
    expect(workflow.authoritativeEvents).toEqual([]);
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

it('holds an actor rejection and does not ACK a duplicate observed revision', () => {
  const rejected: CommandResultEvent[] = [];
  const { workflows, bridge, source } = setup({ fabId, onRejected: (event) => rejected.push(event) });
  workflows.register(fabId, commandId, new RejectingWorkflow());
  const event = result(5, 'executing');
  expect(bridge.receive(event)).toBe('rejected');
  expect(bridge.receive(event)).toBe('rejected');
  expect(bridge.pendingCount).toBe(1);
  expect(rejected).toHaveLength(2);
  expect(bridge.correlationRegistry.lastAppliedRevision(fabId, commandId)).toBeUndefined();
  expect(source.cursors.acknowledged).toBeUndefined();
});
