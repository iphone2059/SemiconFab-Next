import { Effect, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandJournalPage, CommandJournalQuery } from '@/contracts/command-gateway.contract';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import {
  type CommandTestRuntime,
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
    expect(harness.cursors().acknowledged).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.cursors().pendingAcknowledgements).toBe(0);
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
        listFabCommands: async () => emptyRecoveryList(),
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
      runtime.trackCommand('cmd-1');
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
      // No ACK/cover has been issued for the authoritative replay in the transport
      // yet (R3-C wires cover); the safe prefix never jumps to observed.
      const acknowledged = transportSource?.cursors.acknowledged;
      expect(acknowledged?.epoch).toBe('epoch-1');
      expect(acknowledged?.sequence).toBeGreaterThanOrEqual(3);
      expect(acknowledged?.sequence).toBeLessThanOrEqual(7);
      runtime.dispose();
    } finally {
      await harness.dispose();
    }
  });
});
