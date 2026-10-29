import { afterEach, describe, expect, it } from 'vitest';
import type { CommandJournalPage } from '@/contracts/command-gateway.contract';
import {
  type TestFab,
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../../support/command-fakes.ts';

/**
 * Matrix item 2 (frontend half, ADR-010 3, CR-02): recovery must loop journal
 * pages with an explicit epoch until the authoritative latestSequence, validate
 * every page (epoch continuity, strictly increasing sequences, no holes) and fall
 * back to the authoritative FAB listing on epoch mismatch / gap / malformed page.
 *
 * RED baseline: the current FabRuntime fetches one page (limit 256) without an
 * epoch and silently stops; these assertions fail until the recovery state
 * machine + pagination loop land.
 */
const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fab(options: Parameters<typeof createTestFab>[0]): TestFab {
  const created = createTestFab(options);
  fabs.push(created);
  return created;
}

const recoveryState = (runtime: unknown): { phase?: string; attempts?: number; lastError?: string } | undefined =>
  (runtime as { recoveryState?: { phase?: string; attempts?: number; lastError?: string } }).recoveryState;

function emitDirty(source: FakeCommandEventSource, dirty: Record<string, unknown>): void {
  (source.emitDirty as unknown as (value: Record<string, unknown>) => void)(dirty);
}

/** Journal page builder: authoritative sequence 1..latest, page-limited. */
function journalPages(options: { latestSequence: number; epoch?: string; limit?: number }) {
  const calls: Array<{ epoch?: string; afterSequence?: number; limit?: number }> = [];
  const handler = async (
    _siteId: string,
    _fabId: string,
    cursor: { epoch?: string; afterSequence?: number; limit?: number },
  ): Promise<CommandJournalPage> => {
    calls.push({ ...cursor });
    const after = Math.max(0, cursor.afterSequence ?? 0);
    const limit = Math.min(1000, Math.max(1, cursor.limit ?? 256));
    const end = Math.min(options.latestSequence, after + limit);
    const events = Array.from({ length: Math.max(0, end - after) }, (_, index) => {
      const sequence = after + index + 1;
      return {
        sequence,
        fabId: 'fab-a',
        commandId: 'cmd-1',
        revision: sequence,
        outcome: sequence === options.latestSequence ? 'succeeded' : 'executing',
        occurredAt: '2026-10-30T00:00:00.000Z',
      };
    });
    return {
      epoch: options.epoch ?? 'epoch-1',
      hasGap: false,
      firstRetainedSequence: 0,
      latestSequence: options.latestSequence,
      events,
      nextAfterSequence: end,
    } as unknown as CommandJournalPage;
  };
  return { calls, handler };
}

function baseGateway(overrides: Parameters<typeof fakeCommandGateway>[0]) {
  return fakeCommandGateway({
    listFabCommands: async () => emptyRecoveryList(),
    getCommandStatus: async (targetFab: string, commandId: string) =>
      commandResult({ fabId: targetFab, commandId, revision: 0, outcome: 'accepted' }),
    ...overrides,
  });
}

describe('matrix 2: journal pagination with epoch (ADR-010 3)', () => {
  it('loops pages until the authoritative latestSequence (257 events = 2 pages)', async () => {
    const source = new FakeCommandEventSource();
    const journal = journalPages({ latestSequence: 257 });
    const gateway = baseGateway({ getCommandJournalPage: journal.handler });
    const created = fab({ source, gateway });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(10);

    emitDirty(source, { reason: 'overflow', droppedCount: 3, delivered: { epoch: 'epoch-1', sequence: 0 }, gapStart: 1 });
    await expect.poll(() => journal.calls.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(2);
    expect(journal.calls[0]).toMatchObject({ epoch: 'epoch-1', afterSequence: 0 });
    expect(journal.calls[1]?.afterSequence).toBe(256);
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(257);
    expect(runtime.getProjection('cmd-1')?.outcome).toBe('succeeded');
    expect(recoveryState(runtime)?.phase).toBe('Healthy');
    // Journal recovery alone reaches the watermark; no authoritative list needed.
    expect(gateway.listCalls.length).toBe(1);
  });

  it('pages 1/256/257/1000 events with strict epoch continuity', async () => {
    const cases: Array<{ latest: number; minPages: number }> = [
      { latest: 1, minPages: 1 },
      { latest: 256, minPages: 1 },
      { latest: 257, minPages: 2 },
      { latest: 1000, minPages: 4 },
    ];
    for (const testCase of cases) {
      const source = new FakeCommandEventSource();
      const journal = journalPages({ latestSequence: testCase.latest });
      const gateway = baseGateway({ getCommandJournalPage: journal.handler });
      const created = fab({ source, gateway });
      created.runtime.start();
      created.runtime.trackCommand('cmd-1');
      await flush(5);
      emitDirty(source, { reason: 'overflow', droppedCount: 1, delivered: { epoch: 'epoch-1', sequence: 0 }, gapStart: 1 });
      await expect.poll(() => journal.calls.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(testCase.minPages);
      expect(journal.calls.every((call) => call.epoch === 'epoch-1')).toBe(true);
      await expect.poll(() => created.runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(testCase.latest);
    }
  });

  it('falls back to the authoritative list when the journal epoch is replaced (409)', async () => {
    const source = new FakeCommandEventSource();
    let journalAttempts = 0;
    const gateway = baseGateway({
      getCommandJournalPage: async () => {
        journalAttempts += 1;
        throw new Error('409 journal-epoch-mismatch');
      },
      listFabCommands: async () =>
        emptyRecoveryList([
          commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 7, outcome: 'executing' }),
        ]),
    });
    const created = fab({ source, gateway });
    created.runtime.start();
    created.runtime.trackCommand('cmd-1');
    await flush(5);
    const listCallsBefore = gateway.listCalls.length;
    emitDirty(source, { reason: 'stale-generation', droppedCount: 1, delivered: { epoch: 'old-epoch', sequence: 4 }, gapStart: 5 });
    await expect.poll(() => gateway.listCalls.length, { timeout: 2_000 }).toBeGreaterThan(listCallsBefore);
    expect(journalAttempts).toBeGreaterThanOrEqual(1);
    await expect.poll(() => created.runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(7);
    expect(recoveryState(created.runtime)?.phase).toBe('Healthy');
  });

  it('treats a sequence hole as a gap and recovers from the authoritative list', async () => {
    const source = new FakeCommandEventSource();
    const gateway = baseGateway({
      getCommandJournalPage: async () =>
        ({
          epoch: 'epoch-1',
          hasGap: false,
          firstRetainedSequence: 0,
          latestSequence: 10,
          events: [
            { sequence: 2, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing', occurredAt: 'now' },
            // sequence 3 is missing: a silent hole must force authoritative recovery.
            { sequence: 4, fabId: 'fab-a', commandId: 'cmd-1', revision: 4, outcome: 'executing', occurredAt: 'now' },
          ],
          nextAfterSequence: 4,
        }) as unknown as CommandJournalPage,
      listFabCommands: async () =>
        emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 9, outcome: 'executing' })]),
    });
    const created = fab({ source, gateway });
    created.runtime.start();
    created.runtime.trackCommand('cmd-1');
    await flush(5);
    const listCallsBefore = gateway.listCalls.length;
    emitDirty(source, { reason: 'overflow', droppedCount: 1, delivered: { epoch: 'epoch-1', sequence: 1 }, gapStart: 2 });
    await expect.poll(() => gateway.listCalls.length, { timeout: 2_000 }).toBeGreaterThan(listCallsBefore);
    await expect.poll(() => created.runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(9);
  });

  it('continues across a page whose events are all another FAB (sequence watermark decides)', async () => {
    const source = new FakeCommandEventSource();
    let pageRequests = 0;
    const gateway = baseGateway({
      getCommandJournalPage: async (_siteId: string, _fabId: string, cursor: { afterSequence?: number }) => {
        pageRequests += 1;
        const after = cursor.afterSequence ?? 0;
        if (after === 0) {
          return {
            epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 10,
            events: [
              { sequence: 1, fabId: 'fab-b', commandId: 'other', revision: 1, outcome: 'executing', occurredAt: 'now' },
              { sequence: 2, fabId: 'fab-b', commandId: 'other', revision: 2, outcome: 'executing', occurredAt: 'now' },
            ],
            nextAfterSequence: 2,
          } as unknown as CommandJournalPage;
        }
        // Sequences stay site-wide contiguous (3..10); only the last event is ours.
        return {
          epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 10,
          events: Array.from({ length: 8 }, (_, index) => {
            const sequence = index + 3;
            const ours = sequence === 10;
            return {
              sequence,
              fabId: ours ? 'fab-a' : 'fab-b',
              commandId: ours ? 'cmd-1' : 'other',
              revision: sequence,
              outcome: ours ? ('succeeded' as const) : ('executing' as const),
              occurredAt: 'now',
            };
          }),
          nextAfterSequence: 10,
        } as unknown as CommandJournalPage;
      },
    });
    const created = fab({ source, gateway });
    created.runtime.start();
    created.runtime.trackCommand('cmd-1');
    await flush(5);
    emitDirty(source, { reason: 'overflow', droppedCount: 1, delivered: { epoch: 'epoch-1', sequence: 0 }, gapStart: 1 });
    await expect.poll(() => created.runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(10);
    expect(pageRequests).toBe(2);
  });
});
