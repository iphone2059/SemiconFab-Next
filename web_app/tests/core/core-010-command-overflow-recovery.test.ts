import { Effect, Exit, Scope } from 'effect';
import { afterEach, expect, it } from 'vitest';
import type { CommandStreamDirty } from '@/contracts/command-events.contract';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import { COMMAND_RESULT_TOPIC } from '@/realtime/message-decoder';
import { runCommandStream } from '@/runtime/command-stream';
import {
  FakeCommandEventSource,
  type TestFab,
  commandRecord,
  commandResult,
  createCommandTestRuntime,
  createTestFab,
  emptyJournalPage,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data: string; lastEventId?: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(payload: unknown, lastEventId?: string): void {
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId });
  }
  close(): void {
    this.closed = true;
  }
}

const commandEnvelope = (revision: number): unknown => ({
  topic: COMMAND_RESULT_TOPIC,
  sequence: revision,
  payload: { fabId: 'fab-a', commandId: 'cmd-1', revision, outcome: 'executing', occurredAt: '2026-10-27T00:00:00Z' },
});

it('CORE-010a bounded transport bus overflows into dirty signals instead of silent loss', async () => {
  const harness = createCommandTestRuntime();
  const transportScope = Scope.makeUnsafe();
  try {
    const sources: FakeEventSource[] = [];
    const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
      host: {
        addFinalizer: (finalizer) => {
          harness.host.runSync(Scope.addFinalizer(transportScope, Effect.sync(finalizer)));
        },
      },
      eventSourceFactory: (url) => {
        const created = new FakeEventSource(url);
        sources.push(created);
        return created;
      },
      capacity: 16,
    });
    const received: number[] = [];
    const dirtySignals: CommandStreamDirty[] = [];
    runCommandStream(harness.host, transportScope, source.commandResults, (event) => received.push(event.revision));
    runCommandStream(harness.host, transportScope, source.dirty!, (dirty) => dirtySignals.push(dirty));
    await flush();
    expect(sources).toHaveLength(1);
    sources[0].onopen?.();
    // The consumer fiber cannot drain while this synchronous burst is produced.
    for (let revision = 0; revision < 40; revision += 1) sources[0].emit(commandEnvelope(revision));
    await flush();

    expect(received.length).toBeLessThanOrEqual(16);
    expect(dirtySignals.length).toBeGreaterThan(0);
    const lastDirty = dirtySignals[dirtySignals.length - 1];
    expect(lastDirty.reason).toBe('overflow');
    expect(lastDirty.droppedCount).toBeGreaterThanOrEqual(24);

    harness.host.runSync(Scope.close(transportScope, Exit.void));
    await flush();
    expect(sources[0].closed).toBe(true);
  } finally {
    await harness.dispose();
  }
});

it('CORE-010b dirty overflow triggers authoritative reconciliation without losing unconfirmed commands', async () => {
  const source = new FakeCommandEventSource();
  const gateway = fakeCommandGateway({
    listFabCommands: async () =>
      emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId: 'recovered', revision: 1, outcome: 'executing' })]),
    getCommandJournalPage: async () => emptyJournalPage(),
    getCommandStatus: async (fabId, commandId) =>
      commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }),
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();

  // Startup list recovery: a command from a previous page lifetime is tracked again.
  await expect.poll(() => runtime.workflowCount, { timeout: 1_000 }).toBe(1);
  expect(runtime.getWorkflow('recovered')).toBeDefined();

  const listCallsBefore = gateway.listCalls.length;
  // No cursor in the dirty frame: authoritative LIST recovery is the only way back.
  source.emitDirty({ reason: 'overflow', droppedCount: 5 });
  await expect.poll(() => gateway.listCalls.length, { timeout: 1_000 }).toBeGreaterThan(listCallsBefore);
  await expect.poll(() => runtime.getProjection('recovered')?.outcome, { timeout: 1_000 }).toBe('succeeded');
  expect(runtime.lastDirtySignal).toMatchObject({ reason: 'overflow', droppedCount: 5 });
});

it('CORE-010c a journal page without gap replays events instead of listing', async () => {
  const source = new FakeCommandEventSource();
  const gateway = fakeCommandGateway({
    getCommandJournalPage: async () => ({
      epoch: 'epoch-1',
      hasGap: false,
      firstRetainedSequence: 0,
      latestSequence: 3,
      events: [
        { sequence: 2, fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing', occurredAt: '2026-10-27T00:00:00.000Z' },
        { sequence: 3, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00.000Z' },
      ],
    }),
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('cmd-1');
  await flush();
  source.emitGap({ epoch: 'epoch-1', sequence: 1 });
  await expect.poll(() => runtime.getProjection('cmd-1')?.outcome, { timeout: 1_000 }).toBe('succeeded');
  expect(gateway.journalCalls.length).toBeGreaterThan(0);
  const listCalls = gateway.listCalls.length;
  await flush();
  expect(gateway.listCalls.length).toBe(listCalls);
});
