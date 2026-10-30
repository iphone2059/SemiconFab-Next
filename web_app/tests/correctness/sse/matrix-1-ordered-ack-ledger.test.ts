import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResultEvent, CommandStreamDirty } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import { FakeWorkflowRegistry } from '../../support/command-fakes.ts';
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
    // prefix becomes an observable Dirty (authoritative recovery covers it). The
    // applied entry stays tracked until the contiguous prefix drains: pending
    // entries are never evicted to move the cursor.
    harness.acknowledge(eventFor(harness, 11));
    await flush(5);
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(2);
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

    // The tracked prefix is provable, so it drains; the untracked frame 3 caps the
    // acknowledged cursor (R4-01: never drain the safe prefix past the latch).
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

    // Authoritative List cover switches the epoch; the stale epoch-1 frame cannot
    // move it. A journal cover cannot release an untracked cross-epoch position
    // (R4-01: the authority must be 'list').
    harness.cover({ epoch: 'epoch-2', sequence: 6 }, 'list');
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

describe('R4-01 unified untrusted-gap ACK latch', () => {
  it('records a frame delivered while latched and refuses a cover below the untracked high water', async () => {
    const harness = transport({ capacity: 16, autoAck: false, ackLedgerCapacity: 1 });
    const source = await open(harness);
    // Journal positions 200 (tracked, pending) and 201 (delivered but not tracked:
    // the ledger is at capacity). The authoritative snapshot watermark 200 is
    // produced before the cover response reaches the transport, so 201 arrives
    // while the ACK latch is already engaged.
    source.emit(commandEnvelope({ revision: 200, commandId: 'cmd-a' }), cursorId('epoch-1', 200));
    source.emit(commandEnvelope({ revision: 201, commandId: 'cmd-a' }), cursorId('epoch-1', 201));
    await flush(10);
    expect(harness.receivedRevisions).toEqual([200, 201]);
    expect(lastDirty(harness).reason).toBe('ack-ledger-overflow');
    expect(harness.cursors().pendingAcknowledgements).toBe(1);

    // A cover at the pre-arrival watermark (200) is safe for the tracked prefix but
    // cannot release the latch: 201 was delivered but never appended to the ledger.
    harness.cover({ epoch: 'epoch-1', sequence: 200 });
    await flush(5);
    expect(lastDirty(harness).reason).toBe('uncovered-gap');
    expect(lastDirty(harness).gapStart).toBeUndefined();
    expect(lastDirty(harness).delivered).toBeUndefined();
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(1);

    // While latched, every further accepted frame extends the untracked high water.
    // Even the authoritative List authority cannot release a watermark below that
    // position (a snapshot taken before frame 202 arrived): 202 must never be skipped.
    source.emit(commandEnvelope({ revision: 202, commandId: 'cmd-a' }), cursorId('epoch-1', 202));
    await flush(5);
    expect(harness.receivedRevisions).toEqual([200, 201, 202]);
    harness.cover({ epoch: 'epoch-1', sequence: 201 }, 'list');
    await flush(5);
    expect(lastDirty(harness).reason).toBe('uncovered-gap');
    expect(harness.cursors().acknowledged).toBeUndefined();

    // Only a cover at/above the highest untracked position releases the latch, and a
    // release is not itself a Dirty signal.
    const dirtyBeforeRelease = harness.dirty.length;
    harness.cover({ epoch: 'epoch-1', sequence: 202 });
    await flush(5);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 202 });
    expect(harness.dirty.length).toBe(dirtyBeforeRelease);

    // ACK tracking resumes after the release.
    source.emit(commandEnvelope({ revision: 203, commandId: 'cmd-a' }), cursorId('epoch-1', 203));
    await flush(5);
    expect(harness.cursors().pendingAcknowledgements).toBe(1);
    harness.acknowledge(eventFor(harness, 203));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 203 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);
  });

  it('requires the authoritative List authority to release an unknown untracked position', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 10 }), cursorId('epoch-1', 10));
    await flush(5);
    expect(harness.cursors().pendingAcknowledgements).toBe(1);

    // A server dirty control frame proves that events may be missing but cannot
    // prove any client position: the untracked position is unknown.
    source.emitNamed(
      'dirty',
      JSON.stringify({ reason: 'store-fault', droppedCount: 1, epoch: 'epoch-1', sequence: 10, occurredAt: '2026-10-30T00:00:00Z' }),
      cursorId('epoch-1', 10),
    );
    await flush(5);
    expect(lastDirty(harness).reason).toBe('store-fault');

    // A journal cover is authoritative for its scanned range but cannot prove the
    // unknown position: the latch stays and the consumer must retry with a List.
    harness.cover({ epoch: 'epoch-1', sequence: 10 }, 'journal');
    await flush(5);
    expect(lastDirty(harness).reason).toBe('uncovered-gap');
    expect(lastDirty(harness).gapStart).toBeUndefined();
    expect(harness.cursors().acknowledged).toBeUndefined();

    // The full authoritative List authority releases the latch.
    const dirtyBeforeList = harness.dirty.length;
    harness.cover({ epoch: 'epoch-1', sequence: 10 }, 'list');
    await flush(5);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 10 });
    expect(harness.dirty.length).toBe(dirtyBeforeList);

    // ...and only then does a plain journal cover stop signalling uncovered-gap.
    harness.cover({ epoch: 'epoch-1', sequence: 10 }, 'journal');
    await flush(5);
    expect(harness.dirty.length).toBe(dirtyBeforeList);
  });

  it('consumer-queue overflow latches the ACK state until a cover covers the dropped range', async () => {
    const harness = transport({ capacity: 4 });
    const source = await open(harness);
    // Synchronous burst: the consumer fiber cannot drain, so only 0..3 are delivered
    // and 4..9 are lost for the bounded consumer queue.
    for (let sequence = 0; sequence < 10; sequence += 1) {
      source.emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(10);
    expect(harness.receivedRevisions).toEqual([0, 1, 2, 3]);
    expect(lastDirty(harness).reason).toBe('overflow');
    expect(lastDirty(harness).gapStart).toBe(4);
    expect(lastDirty(harness).gapEnd).toBe(9);

    // The tracked applied prefix drains below the lost range; the latch itself is a
    // separate sticky state (no cover has proven the dropped frames yet).
    expect(harness.cursors().acknowledged).toBeUndefined();

    // A cover below the untracked high water (9) advances the conservative safe
    // watermark to 7 but keeps the latch and forces another List pass.
    harness.cover({ epoch: 'epoch-1', sequence: 7 }, 'journal');
    await flush(5);
    expect(lastDirty(harness).reason).toBe('uncovered-gap');
    expect(harness.cursors().acknowledged).toBeUndefined();

    // A cover at/above the high water releases it (List authority supersedes the
    // journal-generated loss).
    harness.cover({ epoch: 'epoch-1', sequence: 9 }, 'list');
    await flush(5);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 9 });
  });
});

describe('bridge acknowledges only after the actor applied (R3-02 three-state split)', () => {
  it('does not acknowledge an unverifiable workflow and respects the pending prefix', async () => {
    const sourceHarness = createTransportHarness({ capacity: 16, autoAck: false });
    const source = sourceHarness.source;
    const workflows = new FakeWorkflowRegistry();
    const unverifiableEvents: CommandResultEvent[] = [];
    const unverifiable: CommandWorkflow = {
      receiveRealtime(event: CommandResultEvent) { unverifiableEvents.push(event); },
      receiveAuthoritative(event: CommandResultEvent) { unverifiableEvents.push(event); },
      markExpiredUnresolved() {},
      async reconcile() {},
      dispose() {},
    };
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
      expect(unverifiableEvents).toHaveLength(1);
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
});

/**
 * Test workflow that exposes a projection and advances it synchronously. Round 5.1
 * source isolation: the realtime channel is strictly monotonic, while the
 * authoritative channel may repair an equal revision but never roll one back.
 */
class ProjectionWorkflow implements CommandWorkflow {
  markExpiredUnresolved(): void {}
  received = 0;
  realtimeReceived = 0;
  authoritativeReceived = 0;
  private revisionValue = -1;
  private outcomeValue: CommandWorkflowProjection['outcome'] = 'pending';

  receiveRealtime(event: CommandResultEvent): void {
    this.realtimeReceived += 1;
    if (event.revision <= this.revisionValue) return;
    this.apply(event);
  }

  receiveAuthoritative(event: CommandResultEvent): void {
    this.authoritativeReceived += 1;
    if (event.revision < this.revisionValue) return;
    if (event.revision === this.revisionValue && event.outcome === this.outcomeValue) return;
    this.apply(event);
  }

  async reconcile(): Promise<void> {}

  dispose(): void {}

  get projection(): CommandWorkflowProjection {
    return { state: this.outcomeValue === 'pending' ? 'idle' : this.outcomeValue, revision: this.revisionValue, outcome: this.outcomeValue, recoveryDisposition: 'tracked' };
  }

  private apply(event: CommandResultEvent): void {
    this.received += 1;
    this.revisionValue = event.revision;
    this.outcomeValue = event.outcome;
  }
}


it('does not mutate cursors when a list snapshot predates a new unknown gap', async () => {
  const harness = transport({ autoAck: false });
  const eventSource = await open(harness);
  eventSource.emit(commandEnvelope({ revision: 1 }), cursorId('epoch-1', 1));
  await flush(5);
  const barrier = harness.source.lossGeneration;
  eventSource.emitNamed('dirty', JSON.stringify({ reason: 'store-fault', droppedCount: 1, epoch: 'epoch-1', sequence: 1, occurredAt: '2026-10-30T00:00:00Z' }), cursorId('epoch-1', 1));
  await flush(5);
  const before = harness.cursors();
  expect(harness.source.cover({ epoch: 'epoch-1', sequence: 1 }, 'list', barrier).status).toBe('insufficient');
  expect(harness.cursors()).toEqual(before);
  expect(harness.source.cover({ epoch: 'epoch-1', sequence: 1 }, 'list', harness.source.lossGeneration).status).toBe('covered');
});
describe('Round 5.1 / P1-04 cover never forges the delivered cursor', () => {
  it('advances acknowledged only over proven entries and keeps a delivered frame after the watermark pending', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    for (const sequence of [20, 21, 22]) {
      source.emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(10);
    expect(harness.cursors().observed).toEqual({ epoch: 'epoch-1', sequence: 22 });
    expect(harness.cursors().delivered).toEqual({ epoch: 'epoch-1', sequence: 22 });
    expect(harness.cursors().pendingAcknowledgements).toBe(3);

    harness.acknowledge(eventFor(harness, 20));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 20 });

    // Authoritative cover watermark 21: the tracked entry at 21 becomes covered, but
    // the delivered frame at 22 is AFTER the watermark and must stay pending.
    const cover = harness.source.cover({ epoch: 'epoch-1', sequence: 21 }, 'list', harness.source.lossGeneration);
    expect(cover.status).toBe('covered');
    await flush(5);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-1', sequence: 22 },
      delivered: { epoch: 'epoch-1', sequence: 22 },
      acknowledged: { epoch: 'epoch-1', sequence: 21 },
      pendingAcknowledgements: 1,
    });
    // The safe prefix never jumps the pending delivered entry at 22.
    expect(harness.cursors().acknowledged!.sequence).toBeLessThan(harness.cursors().delivered!.sequence);

    // The after-watermark entry joins the safe prefix only when the actor applies it.
    harness.acknowledge(eventFor(harness, 22));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 22 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);

    // A later cover above every delivered frame still never moves delivered: a
    // cover is authoritative coverage, not an SSE delivery.
    harness.source.cover({ epoch: 'epoch-1', sequence: 25 }, 'list', harness.source.lossGeneration);
    expect(harness.cursors().delivered).toEqual({ epoch: 'epoch-1', sequence: 22 });
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 25 });
  });

  it('accepts a cross-epoch List cover as the safe watermark but keeps delivered in the old epoch', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    const source = await open(harness);
    source.emit(commandEnvelope({ revision: 10 }), cursorId('epoch-a', 10));
    source.emit(commandEnvelope({ revision: 11 }), cursorId('epoch-a', 11));
    await flush(10);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-a', sequence: 11 },
      delivered: { epoch: 'epoch-a', sequence: 11 },
      pendingAcknowledgements: 2,
    });
    expect(harness.cursors().acknowledged).toBeUndefined();

    // The authoritative List proves the journal moved to a new epoch. It replaces
    // the ledger/safe watermark, but it is not an SSE frame: delivered must stay at
    // the last frame actually published to the bounded consumer.
    const cover = harness.source.cover({ epoch: 'epoch-b', sequence: 20 }, 'list', harness.source.lossGeneration);
    expect(cover).toMatchObject({ status: 'covered', latchReleased: false });
    await flush(5);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-a', sequence: 11 },
      delivered: { epoch: 'epoch-a', sequence: 11 },
      acknowledged: { epoch: 'epoch-b', sequence: 20 },
      pendingAcknowledgements: 0,
    });

    // Only a real epoch-b frame that is successfully published moves delivered into
    // the new epoch, and only to its actual sequence.
    source.emit(commandEnvelope({ revision: 21 }), cursorId('epoch-b', 21));
    await flush(10);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-b', sequence: 21 },
      delivered: { epoch: 'epoch-b', sequence: 21 },
      acknowledged: { epoch: 'epoch-b', sequence: 20 },
      pendingAcknowledgements: 1,
    });
    harness.acknowledge(eventFor(harness, 21));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-b', sequence: 21 });
  });
});

