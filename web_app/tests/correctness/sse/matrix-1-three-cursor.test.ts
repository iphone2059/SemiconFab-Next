import { Effect, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandJournalPage, CommandJournalQuery } from '@/contracts/command-gateway.contract';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import {
  type CommandTestRuntime,
  commandRecord,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../../support/command-fakes.ts';
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
 * Matrix item 1 (ADR-010 §2/§6.2/§6.4, CR-01/R3-02/R3-04): bounded SSE exposes
 * observed / delivered / acknowledged separated by an ordered ACK ledger; a dirty
 * signal never carries a cursor that would skip an unapplied event.
 */
const transportHarnesses: TransportHarness[] = [];
afterEach(async () => {
  for (const harness of transportHarnesses.splice(0)) await disposeTransportHarness(harness);
});

function transport(options: Parameters<typeof createTransportHarness>[0] = {}): TransportHarness {
  const harness = createTransportHarness(options);
  transportHarnesses.push(harness);
  return harness;
}

describe('matrix 1: three-cursor transport with ordered safe prefix (ADR-010 §6.2)', () => {
  it('advances delivered only when the bounded queue accepted the frame and reports an exact gap with the safe prefix', async () => {
    const harness = transport({ capacity: 4 });
    await flush();
    expect(harness.sources).toHaveLength(1);
    harness.sources[0].onopen?.();
    // Synchronous burst: the consumer fiber cannot drain between frames, so the
    // bus capacity decides exactly which frames are delivered.
    for (let sequence = 0; sequence < 100; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(20);

    expect(harness.receivedRevisions).toEqual([0, 1, 2, 3]);
    expect(harness.dirty.length).toBeGreaterThan(0);
    const lastDirty = harness.dirty[harness.dirty.length - 1];
    expect(lastDirty.reason).toBe('overflow');
    expect(lastDirty.droppedCount).toBe(96);
    // No event has been applied yet when the overflow signal is produced, so the
    // safe prefix is unknown: recovery MUST go through the authoritative List.
    expect(lastDirty.delivered).toBeUndefined();
    expect(lastDirty.gapStart).toBe(4);
    expect(lastDirty.gapEnd).toBe(99);

    // Full three-cursor separation after the consumer applied/acknowledged 0..3.
    expect(harness.cursors().observed).toEqual({ epoch: 'epoch-1', sequence: 99 });
    expect(harness.cursors().delivered).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.cursors().acknowledged).toBeUndefined();
    expect(harness.cursors().pendingAcknowledgements).toBe(4);
  });

  it('acknowledged only advances for delivered events in ledger order and never regresses', async () => {
    const harness = transport({ capacity: 16 });
    await flush();
    harness.sources[0].onopen?.();
    for (let sequence = 0; sequence < 3; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(10);
    expect(harness.receivedRevisions).toEqual([0, 1, 2]);
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 2 });

    // A stale ack (older event) and an ack for a never-delivered event must not move
    // the cursor; the ledger no longer holds them.
    harness.source.acknowledge(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
    harness.source.acknowledge(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 50, outcome: 'succeeded' }));
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 2 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);
  });
});

describe('matrix 1: recovery starts from the safe acknowledged prefix, never observed (CR-01)', () => {
  it('replays the dropped range through the journal and converges the actor', async () => {
    const harness: CommandTestRuntime = createCommandTestRuntime();
    try {
      const eventSources: FakeEventSource[] = [];
      const journalPages: Array<{ afterSequence: number; limit: number }> = [];
      let transportSource: CommandEventSource | undefined;
      const gateway = fakeCommandGateway({
        // Round 5.1 / P1-01 + P2-04: an authoritative List snapshot that omitted
        // cmd-1 while it is locally active would prove it expired-unresolved, so the
        // fake authority must include the command it accepted.
        listFabCommands: async () =>
          emptyRecoveryList([
            commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 0, outcome: 'accepted' }),
          ]),
        getCommandStatus: async (fabId: string, commandId: string) =>
          commandResult({ fabId, commandId, revision: 0, outcome: 'accepted' }),
        getCommandJournalPage: async (
          _siteId: string,
          _fabId: string,
          cursor: CommandJournalQuery,
        ): Promise<CommandJournalPage> => {
          const after = Math.max(0, cursor.afterSequence ?? 0);
          journalPages.push({ afterSequence: after, limit: cursor.limit ?? 0 });
          const events = Array.from({ length: 100 }, (_, sequence) => sequence)
            .filter((sequence) => sequence > after)
            .map((sequence) => ({
              sequence,
              fabId: 'fab-a',
              commandId: 'cmd-1',
              revision: sequence,
              outcome: sequence === 99 ? ('succeeded' as const) : ('executing' as const),
              occurredAt: '2026-10-30T00:00:00.000Z',
            }));
          return {
            epoch: 'epoch-1',
            hasGap: false,
            firstRetainedSequence: 0,
            latestSequence: 99,
            events,
            nextAfterSequence: 99,
          };
        },
      });
      const runtime = createFabRuntime(harness, {
        gateway,
        sourceFor: (_fabId: string, scope: Scope.Scope) => {
          const created = createSseCommandEventSource(
            '/api/v1/sites/site-1/commands/stream?fabId=fab-a',
            {
              host: {
                addFinalizer: (finalizer) => {
                  harness.host.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
                },
              },
              eventSourceFactory: (url: string) => {
                const fake = new FakeEventSource(url);
                eventSources.push(fake);
                return fake;
              },
              capacity: 4,
            },
          );
          transportSource = created;
          return created;
        },
      });
      runtime.start();
      runtime.registerAcceptedCommand('cmd-1');
      await flush(20);
      expect(eventSources).toHaveLength(1);
      eventSources[0].onopen?.();

      // Phase 1: deliver + apply + ACK a safe prefix 0..3 (bridge/actor path).
      for (let sequence = 0; sequence < 4; sequence += 1) {
        eventSources[0].emit(
          commandEnvelope({ revision: sequence, outcome: sequence === 0 ? 'accepted' : 'executing' }),
          cursorId('epoch-1', sequence),
        );
      }
      await flush(20);
      expect(transportSource?.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 3 });
      expect(transportSource?.cursors.pendingAcknowledgements).toBe(0);

      // Phase 2: 96-frame synchronous burst; the consumer cannot drain the
      // capacity-4 bus, so 4..7 are delivered and 8..99 are dropped.
      for (let sequence = 4; sequence < 100; sequence += 1) {
        eventSources[0].emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
      }
      await expect.poll(() => journalPages.length, { timeout: 2_000 }).toBeGreaterThan(0);
      // The authoritative journal must be read from the safe ACK prefix (3), never
      // from the observed sequence (99).
      expect(journalPages[0].afterSequence).toBe(3);
      await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(99);
      expect(runtime.getProjection('cmd-1')?.outcome).toBe('succeeded');
      await expect.poll(() => runtime.recoveryState.phase, { timeout: 2_000 }).toBe('Healthy');
      // R4-01: recovery signs its authoritative watermark via cover(). The journal
      // loop started at the safe ACK prefix (3) and scanned the whole dropped range
      // (4..99), so it provably covers the untracked high water 99 and the
      // acknowledged cursor may jump to the authoritative watermark — never to the
      // observed cursor as a shortcut.
      await expect.poll(() => transportSource?.cursors.acknowledged?.sequence, { timeout: 2_000 }).toBe(99);
      expect(transportSource?.cursors.acknowledged?.epoch).toBe('epoch-1');
      expect(transportSource?.cursors.pendingAcknowledgements).toBe(0);
      runtime.dispose();
    } finally {
      await harness.dispose();
    }
  });
});
describe('Round 5.1 / P1-04 cover never forges the delivered cursor (ADR-010 §6.3)', () => {
  it('List cover may advance acknowledged beyond delivered because the dropped range is proven, but delivered stays the last real delivery', async () => {
    const harness = transport({ capacity: 4, autoAck: false });
    await flush();
    // Synchronous burst: only 0..3 fit the bounded consumer bus; 4..9 are observed
    // (valid SSE ids) but never delivered, and the ACK latch records the high water.
    for (let sequence = 0; sequence < 10; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), cursorId('epoch-1', sequence));
    }
    await flush(20);
    expect(harness.receivedRevisions).toEqual([0, 1, 2, 3]);
    expect(harness.cursors().observed).toEqual({ epoch: 'epoch-1', sequence: 9 });
    expect(harness.cursors().delivered).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.cursors().pendingAcknowledgements).toBe(4);

    // A List cover below the proven untracked high water is not authoritative for
    // the dropped range: it changes nothing (cursor/ledger/loss identity included).
    const before = harness.cursors();
    const lossBefore = harness.source.lossGeneration;
    const refused = harness.source.cover({ epoch: 'epoch-1', sequence: 7 }, 'journal', lossBefore);
    expect(refused.status).toBe('insufficient');
    expect(harness.cursors()).toEqual(before);
    expect(harness.source.lossGeneration).toBe(lossBefore);

    // The authoritative List watermark 9 proves the whole dropped range. The
    // acknowledged safe cursor may jump to it, but delivered must NOT be forged to
    // 9: only an actual SSE frame published to the bounded consumers moves it.
    const covered = harness.source.cover({ epoch: 'epoch-1', sequence: 9 }, 'list', lossBefore);
    expect(covered).toMatchObject({ status: 'covered', latchReleased: true });
    await flush(5);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-1', sequence: 9 },
      delivered: { epoch: 'epoch-1', sequence: 3 },
      acknowledged: { epoch: 'epoch-1', sequence: 9 },
      pendingAcknowledgements: 0,
    });
    // Nothing was published after the cover: delivered is unchanged and cannot
    // exceed the frames the bounded consumer actually accepted.
    expect(harness.receivedRevisions).toEqual([0, 1, 2, 3]);

    // Only a new real delivery moves delivered, monotonically, inside the epoch.
    harness.sources[0].emit(commandEnvelope({ revision: 10 }), cursorId('epoch-1', 10));
    await flush(10);
    expect(harness.cursors().delivered).toEqual({ epoch: 'epoch-1', sequence: 10 });
    expect(harness.cursors().observed).toEqual({ epoch: 'epoch-1', sequence: 10 });
  });

  it('cross-epoch List cover replaces acknowledged/epoch identity but delivered stays in the old epoch until a real frame arrives', async () => {
    const harness = transport({ capacity: 16, autoAck: false });
    await flush();
    harness.sources[0].onopen?.();
    // Delivered epoch-a:10 with eight applied (0..7) and later entries still pending.
    for (let sequence = 0; sequence <= 10; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), cursorId('epoch-a', sequence));
    }
    await flush(10);
    for (let sequence = 0; sequence < 8; sequence += 1) {
      harness.source.acknowledge(harness.received.find((event) => event.revision === sequence)!);
    }
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-a', sequence: 10 },
      delivered: { epoch: 'epoch-a', sequence: 10 },
      acknowledged: { epoch: 'epoch-a', sequence: 7 },
      pendingAcknowledgements: 3,
    });

    // The authoritative List proves an epoch replacement; only the List authority
    // may accept it. The cover is NOT a delivered frame: acknowledged moves into
    // epoch-b, delivered must remain the last epoch-a frame actually delivered.
    const result = harness.source.cover({ epoch: 'epoch-b', sequence: 20 }, 'list', harness.source.lossGeneration);
    expect(result).toMatchObject({ status: 'covered', latchReleased: false });
    await flush(5);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-a', sequence: 10 },
      delivered: { epoch: 'epoch-a', sequence: 10 },
      acknowledged: { epoch: 'epoch-b', sequence: 20 },
      pendingAcknowledgements: 0,
    });

    // A real epoch-b frame is the only thing that moves delivered into the new epoch.
    harness.sources[0].emit(commandEnvelope({ revision: 21 }), cursorId('epoch-b', 21));
    await flush(10);
    expect(harness.cursors()).toMatchObject({
      observed: { epoch: 'epoch-b', sequence: 21 },
      delivered: { epoch: 'epoch-b', sequence: 21 },
      acknowledged: { epoch: 'epoch-b', sequence: 20 },
      pendingAcknowledgements: 1,
    });
  });
});

