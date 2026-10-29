import { Effect, Scope } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
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
  type RoundTwoDirty,
  commandEnvelope,
  createTransportHarness,
  disposeTransportHarness,
  flush,
  type TransportHarness,
} from './support/transport-harness.ts';

/**
 * Matrix item 1 (ADR-010 2, CR-01): bounded SSE must expose three cursors —
 * observed / delivered / acknowledged — and a dirty signal must carry the
 * conservative delivered cursor plus the precise dropped sequence range.
 */
const transportHarnesses: TransportHarness[] = [];
afterEach(async () => {
  for (const harness of transportHarnesses.splice(0)) await disposeTransportHarness(harness);
});

function transport(options: { capacity?: number } = {}): TransportHarness {
  const harness = createTransportHarness(options);
  transportHarnesses.push(harness);
  return harness;
}

describe('matrix 1: three-cursor transport (ADR-010 2)', () => {
  it('advances delivered only when the bounded queue accepted the frame and reports an exact gap', async () => {
    const harness = transport({ capacity: 4 });
    await flush();
    expect(harness.sources).toHaveLength(1);
    harness.sources[0].onopen?.();
    // Synchronous burst: the consumer fiber cannot drain between frames, so the
    // bus capacity decides exactly which frames are delivered.
    for (let sequence = 0; sequence < 100; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), 'epoch-1:' + sequence);
    }
    await flush(20);

    expect(harness.received).toEqual([0, 1, 2, 3]);
    expect(harness.dirty.length).toBeGreaterThan(0);
    const lastDirty: RoundTwoDirty = harness.dirty[harness.dirty.length - 1];
    expect(lastDirty.reason).toBe('overflow');
    expect(lastDirty.droppedCount).toBe(96);
    // The cursor must be the last ACCEPTED frame, never the observed frame.
    expect(lastDirty.delivered).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(lastDirty.gapStart).toBe(4);
    expect(lastDirty.gapEnd).toBe(99);

    expect(harness.source.cursors.observed).toEqual({ epoch: 'epoch-1', sequence: 99 });
    expect(harness.source.cursors.delivered).toEqual({ epoch: 'epoch-1', sequence: 3 });
    expect(harness.source.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 3 });
  });

  it('acknowledged only advances for delivered events and never regresses', async () => {
    const harness = transport({ capacity: 16 });
    await flush();
    harness.sources[0].onopen?.();
    for (let sequence = 0; sequence < 3; sequence += 1) {
      harness.sources[0].emit(commandEnvelope({ revision: sequence }), 'epoch-1:' + sequence);
    }
    await flush(10);
    expect(harness.received).toEqual([0, 1, 2]);
    expect(harness.source.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 2 });

    // A stale ack (older event) and an ack for a never-delivered event must not move the cursor.
    const stale = commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' });
    harness.source.acknowledge(stale);
    const unknown = commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 50, outcome: 'succeeded' });
    harness.source.acknowledge(unknown);
    expect(harness.source.cursors.acknowledged).toEqual({ epoch: 'epoch-1', sequence: 2 });
  });
});

describe('matrix 1: overflow recovery starts from the acknowledged cursor, not the observed one (CR-01)', () => {
  it('replays the exact dropped range through the journal and converges the actor', async () => {
    const harness: CommandTestRuntime = createCommandTestRuntime();
    try {
      const eventSources: FakeEventSource[] = [];
      const journalPages: Array<{ afterSequence: number; limit: number }> = [];
      const gateway = fakeCommandGateway({
        listFabCommands: async () => emptyRecoveryList(),
        getCommandStatus: async (fabId: string, commandId: string) =>
          commandResult({ fabId, commandId, revision: 0, outcome: 'accepted' }),
        getCommandJournalPage: async (_siteId: string, _fabId: string, cursor: CommandJournalQuery): Promise<CommandJournalPage> => {
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
        sourceFor: (_fabId: string, scope: Scope.Scope) =>
          createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
            host: {
              addFinalizer: (finalizer) => {
                harness.host.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
              },
            },
            eventSourceFactory: (url: string) => {
              const created = new FakeEventSource(url);
              eventSources.push(created);
              return created;
            },
            capacity: 4,
          }),
      });
      runtime.start();
      runtime.trackCommand('cmd-1');
      await flush(10);
      expect(eventSources).toHaveLength(1);
      eventSources[0].onopen?.();
      // 100 frames arrive while the bridge consumer cannot drain the capacity-4 bus.
      for (let sequence = 0; sequence < 100; sequence += 1) {
        eventSources[0].emit(commandEnvelope({ revision: sequence }), 'epoch-1:' + sequence);
      }
      // The authoritative journal must be read from the acknowledged cursor (3),
      // never from the observed sequence (99).
      await expect
        .poll(() => journalPages.length, { timeout: 2_000 })
        .toBeGreaterThan(0);
      expect(journalPages[0].afterSequence).toBe(3);
      await expect
        .poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 })
        .toBe(99);
      expect(runtime.getProjection('cmd-1')?.outcome).toBe('succeeded');
      // Recovery reaching the authoritative watermark clears Dirty.
      await expect
        .poll(() => (runtime as unknown as { recoveryState?: { phase?: string } }).recoveryState?.phase, { timeout: 2_000 })
        .toBe('Healthy');
      // And the conservative cursor never regressed below the applied events.
      expect(harness.registry.get(runtime.projectionAtom('cmd-1'))).toMatchObject({ revision: 99 });
      runtime.dispose();
    } finally {
      await harness.dispose();
    }
  });
});
