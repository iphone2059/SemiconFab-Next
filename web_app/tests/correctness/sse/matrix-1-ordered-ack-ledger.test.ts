import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResultEvent, CommandStreamDirty } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import {
  FakeCommandWorkflow,
  FakeWorkflowRegistry,
} from '../../support/command-fakes.ts';
import { COMMAND_RESULT_TOPIC } from '@/realtime/message-decoder';
import {
  FakeEventSource,
  type TransportHarness,
  commandEnvelope,
  createTransportHarness,
  cursorId,
  disposeTransportHarness,
  flush,
} from './support/transport-harness.ts';

/**
 * Matrix item 1 / R3-02 + R3-04 (ADR-010 §6.2/§6.4): the ordered delivered ACK
 * ledger must only advance acknowledged over a contiguous applied|covered prefix,
 * never evict pending entries, accept an authoritative cover/safe watermark and
 * turn every protocol/decode failure into Dirty + authoritative List recovery
 * without ever acknowledging the bad frame.
 *
 * Static-phase note: fixtures only; this file is not executed until the Round 3
 * verification phase.
 */
const harnesses: TransportHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await disposeTransportHarness(harness);
});

function transport(options: Parameters<typeof createTransportHarness>[0] = {}): TransportHarness {
  const harness = createTransportHarness(options);
  harnesses.push(harness);
  return harness;
}

async function open(harness: TransportHarness): Promise<FakeEventSource> {
  await flush();
  expect(harness.sources).toHaveLength(1);
  harness.sources[0].onopen?.();
  return harness.sources[0];
}

function lastDirty(harness: TransportHarness): CommandStreamDirty {
  return harness.dirty[harness.dirty.length - 1];
}

const eventFor = (harness: TransportHarness, revision: number) => {
  const event = harness.received.find((candidate) => candidate.revision === revision);
  if (!event) throw new Error('expected delivered event revision ' + revision);
  return event;
};

describe('ordered ACK ledger (R3-02)', () => {
  it('cannot advance acknowledged past an earlier pending event', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 10, commandId: 'cmd-a' }), cursorId('epoch-1', 10));
    source.emit(commandEnvelope({ revision: 11, commandId: 'cmd-b' }), cursorId('epoch-1', 11));
    await flush(10);
    expect(harness.receivedRevisions).toEqual([10, 11]);
    expect(harness.cursors().pendingAcknowledgements).toBe(2);

    // The later event is applied and acked first: the acknowledged cursor must stay
    // at its previous safe prefix because seq 10 is still pending, and the stalled
    // prefix becomes an observable Dirty (authoritative recovery covers it).
    harness.acknowledge(eventFor(harness, 11));
    await flush(5);
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(1);
    expect(lastDirty(harness).reason).toBe('slow-consumer');
    expect(harness.diagnostics().some((entry) => entry.kind === 'ack-ledger')).toBe(true);

    // Applying the earlier event completes the contiguous prefix.
    harness.acknowledge(eventFor(harness, 10));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 11 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);
  });

  it('turns ledger saturation into Dirty without evicting pending entries and only cover releases the prefix', async () => {
    const harness = transport({ capacity: 16, autoAck: false, ackLedgerCapacity: 2 });
    const source = await open(harness);
    for (const sequence of [1, 2, 3]) {
      source.emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(10);
    expect(harness.cursors().pendingAcknowledgements).toBe(2);
    expect(lastDirty(harness).reason).toBe('ack-ledger-overflow');
    // The safe prefix is unknown/unchanged: no ACK-able cursor is exposed.
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(lastDirty(harness).delivered).toBeUndefined();

    // Even when the tracked prefix is applied, the untracked frame 3 forbids a jump.
    harness.acknowledge(eventFor(harness, 1));
    harness.acknowledge(eventFor(harness, 2));
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(2);

    // Only the authoritative safe watermark releases the latch and drops the backlog.
    harness.cover({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);

    // ACK tracking resumes after the cover; a new contiguous frame advances safely.
    source.emit(commandEnvelope({ revision: 4 }), cursorId('epoch-1', 4));
    await flush(10);
    harness.acknowledge(eventFor(harness, 4));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 4 });
  });

  it('cover marks pending entries covered and stale acks/covers never roll the cursor back', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 20 }), cursorId('epoch-1', 20));
    source.emit(commandEnvelope({ revision: 21 }), cursorId('epoch-1', 21));
    await flush(10);

    // Authoritative List/Journal snapshot covers the whole pending range.
    harness.cover({ epoch: 'epoch-1', sequence: 21 });
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 21 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);

    // Late acknowledgements from the covered range are no-ops, and an older cover
    // must not regress the safe watermark inside the same epoch.
    harness.source.acknowledge(eventFor(harness, 20));
    harness.cover({ epoch: 'epoch-1', sequence: 19 });
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 21 });
  });

  it('requires an authoritative cover before an epoch replacement can advance', async () => {
    const harness = transport({ capacity: 16 });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 5 }), cursorId('epoch-1', 5));
    await flush(10);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 5 });

    // New-epoch data without authoritative recovery: deliver/diagnose but never ACK.
    source.emit(commandEnvelope({ revision: 6 }), cursorId('epoch-2', 6));
    await flush(10);
    expect(lastDirty(harness).reason).toBe('stale-generation');
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 5 });
    harness.source.acknowledge(eventFor(harness, 6));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 5 });

    // Authoritative cover switches the epoch; the stale epoch-1 frame cannot move it.
    harness.cover({ epoch: 'epoch-2', sequence: 6 });
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-2', sequence: 6 });
    source.emit(commandEnvelope({ revision: 7 }), cursorId('epoch-1', 7));
    await flush(10);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-2', sequence: 6 });
  });
});

describe('protocol-error Dirty (R3-04)', () => {
  it('turns malformed command frames, unknown topics and control frames into Dirty and never ACKs', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);

    // 1) JSON parse failure with a usable id -> decode-error, no ACK.
    source.emitData('{"topic": "command.result"', cursorId('epoch-1', 5));
    await flush(5);
    expect(lastDirty(harness).reason).toBe('decode-error');
    expect(lastDirty(harness).delivered).toBeUndefined();
    expect(lastDirty(harness).gapStart).toBeUndefined();
    expect(harness.cursors().acknowledged).toBeUndefined();

    // 2) Unknown topic on the dedicated command stream -> protocol-error.
    source.emit({ topic: 'mystery.topic', sequence: 6, payload: { secret: 'must-not-leak' } }, cursorId('epoch-1', 6));
    await flush(5);
    expect(lastDirty(harness).reason).toBe('protocol-error');
    expect(harness.cursors().acknowledged).toBeUndefined();

    // 3) Known command topic with an invalid payload -> decode-error.
    source.emit({ topic: COMMAND_RESULT_TOPIC, sequence: 7, payload: { fabId: 'fab-a' } }, cursorId('epoch-1', 7));
    await flush(5);
    expect(lastDirty(harness).reason).toBe('decode-error');

    // 4) Malformed server dirty control frame -> invalid-control-frame.
    source.emitNamed('dirty', 'not-json', cursorId('epoch-1', 8));
    await flush(5);
    expect(lastDirty(harness).reason).toBe('invalid-control-frame');

    // 5) Non-command topic decoded by the envelope decoder -> protocol-error.
    source.emit({ topic: 'telemetry.frame', sequence: 9, payload: {} }, cursorId('epoch-1', 9));
    await flush(5);
    expect(lastDirty(harness).reason).toBe('protocol-error');

    expect(harness.cursors().acknowledged).toBeUndefined();
    const diagnostics = harness.diagnostics();
    expect(diagnostics.length).toBeGreaterThanOrEqual(5);
    expect(diagnostics.length).toBeLessThanOrEqual(16);
    expect(diagnostics.some((entry) => entry.kind === 'decode')).toBe(true);
    expect(diagnostics.some((entry) => entry.kind === 'control-frame')).toBe(true);
    // Payload-free diagnostics: no raw frame bodies / secret payload in the log.
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('mystery.topic');
    expect(serialized).not.toContain('{"fabId"');
  });

  it('delivers a command frame without a provable journal id but never acknowledges it', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 1 }));
    await flush(5);
    expect(harness.receivedRevisions).toEqual([1]);
    expect(lastDirty(harness).reason).toBe('protocol-error');
    expect(lastDirty(harness).delivered).toBeUndefined();
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(0);
  });

  it('keeps protocol diagnostics bounded even under a sustained bad-frame storm', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    for (let index = 0; index < 40; index += 1) {
      source.emitData('not-json-' + index, cursorId('epoch-1', index));
    }
    await flush(20);
    const diagnostics = harness.diagnostics();
    expect(diagnostics.length).toBe(16);
    expect(diagnostics.at(-1)?.kind).toBe('decode');
    expect(harness.cursors().acknowledged).toBeUndefined();
  });
});

describe('bridge acknowledges only after the actor applied (R3-02 three-state split)', () => {
  it('does not acknowledge an unverifiable workflow and respects the pending prefix', async () => {
    const sourceHarness = createTransportHarness({ capacity: 16, autoAck: false });
    const source = sourceHarness.source;
    const workflows = new FakeWorkflowRegistry();
    const unverifiable = new FakeCommandWorkflow();
    workflows.register('fab-a', 'cmd-a', unverifiable);
    const bridge = new CommandEventBridge(source, workflows, {
      fabId: 'fab-a',
      runtime: sourceHarness.harness.host,
      scope: sourceHarness.scope,
    });
    bridge.start();
    try {
      const fake = await open(sourceHarness);
      fake.emit(commandEnvelope({ revision: 10, commandId: 'cmd-a' }), cursorId('epoch-1', 10));
      await flush(10);
      expect(unverifiable.events).toHaveLength(1);
      // No projection => application cannot be proven => no ACK.
      expect(source.cursors.acknowledged).toBeUndefined();
      expect(source.cursors.pendingAcknowledgements).toBe(1);

      // A projection-exposing actor proves application and acks, but the earlier
      // pending entry still blocks the acknowledged cursor.
      const applied = new ProjectionWorkflow();
      workflows.register('fab-a', 'cmd-b', applied);
      fake.emit(commandEnvelope({ revision: 11, commandId: 'cmd-b' }), cursorId('epoch-1', 11));
      await flush(10);
      expect(applied.received).toBe(1);
      expect(source.cursors.acknowledged).toBeUndefined();
      // seq 10 stays pending, seq 11 is applied but cannot jump the prefix.
      expect(source.cursors.pendingAcknowledgements).toBe(2);

      // Once the earlier actor is applied (test seam), the contiguous prefix drains.
      source.acknowledge(sourceHarness.received.find((event) => event.commandId === 'cmd-a')!);
      expect(source.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 11 });
      expect(source.cursors.pendingAcknowledgements).toBe(0);
    } finally {
      bridge.dispose();
      await disposeTransportHarness(sourceHarness);
    }
  });

  it('retries an observed but rejected revision through the authoritative path', async () => {
    const sourceHarness = createTransportHarness({ capacity: 16, autoAck: false });
    const source = sourceHarness.source;
    const workflows = new FakeWorkflowRegistry();
    const workflow = new RejectOnceProjectionWorkflow();
    workflows.register('fab-a', 'cmd-retry', workflow);
    const bridge = new CommandEventBridge(source, workflows, {
      fabId: 'fab-a',
      runtime: sourceHarness.harness.host,
      scope: sourceHarness.scope,
    });
    bridge.start();
    try {
      const fake = await open(sourceHarness);
      fake.emit(commandEnvelope({ revision: 12, commandId: 'cmd-retry' }), cursorId('epoch-1', 12));
      await flush(10);
      const event = eventFor(sourceHarness, 12);
      expect(workflow.projection.revision).toBe(-1);
      expect(bridge.pendingCount).toBe(1);
      expect(bridge.correlationRegistry.isApplied(event)).toBe(false);
      expect(source.cursors.acknowledged).toBeUndefined();

      expect(bridge.receiveAuthoritative(event)).toBe('applied');
      expect(workflow.projection.revision).toBe(12);
      expect(bridge.pendingCount).toBe(0);
      expect(bridge.correlationRegistry.isApplied(event)).toBe(true);
      expect(source.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 12 });
    } finally {
      bridge.dispose();
      await disposeTransportHarness(sourceHarness);
    }
  });
});

class RejectOnceProjectionWorkflow implements CommandWorkflow {
  private revisionValue = -1;
  private reject = true;

  receive(event: CommandResultEvent): void {
    if (this.reject) {
      this.reject = false;
      return;
    }
    this.revisionValue = Math.max(this.revisionValue, event.revision);
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return { state: this.revisionValue < 0 ? 'idle' : 'executing', revision: this.revisionValue, outcome: 'executing' };
  }
}

/** Test workflow that exposes a projection and advances it synchronously. */
class ProjectionWorkflow implements CommandWorkflow {
  received = 0;
  private revisionValue = -1;
  private outcomeValue: CommandWorkflowProjection['outcome'] = 'pending';

  receive(event: CommandResultEvent): void {
    if (event.revision <= this.revisionValue) return;
    this.received += 1;
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return { state: this.outcomeValue === 'pending' ? 'idle' : this.outcomeValue, revision: this.revisionValue, outcome: this.outcomeValue };
  }
}
