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
 * Matrix item 2 (frontend half, ADR-010 §3/§6.3, CR-02): recovery must loop journal
 * pages with an explicit epoch until the authoritative latestSequence, validate
 * every page (epoch equality, strict Site-sequence increase, cursor bounds and
 * nextAfterSequence progress) and fall back to the authoritative FAB listing on
 * epoch mismatch / server hasGap / malformed page.
 *
 * R3-03: the Site sequence is global while the page is FAB-filtered, so a FAB-A
 * page may legitimately be 1,3,5,7. A gap between two FAB-A events is never proof
 * of a journal hole; only the server hasGap flag (or an epoch error) is
 * authoritative. Fixtures therefore return FAB-A events only (no FAB-B rows are
 * ever placed into a FAB page).
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

  it('treats the server hasGap flag as authoritative and recovers from the list', async () => {
    const source = new FakeCommandEventSource();
    const gateway = baseGateway({
      getCommandJournalPage: async () =>
        ({
          epoch: 'epoch-1',
          // Server-classified loss: the only authoritative neighbour-gap signal.
          hasGap: true,
          firstRetainedSequence: 5,
          latestSequence: 10,
          events: [],
          nextAfterSequence: 8,
        }) as CommandJournalPage,
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
    expect(created.runtime.lastJournalPage).toMatchObject({ hasGap: true, epoch: 'epoch-1' });
  });

  it('accepts a FAB-filtered sparse Site page (FAB-A 1,3,5,7) without listing', async () => {
    const source = new FakeCommandEventSource();
    const sparsePages: Array<{ afterSequence?: number }> = [];
    const gateway = baseGateway({
      getCommandJournalPage: async (_siteId: string, _fabId: string, cursor: { afterSequence?: number }) => {
        sparsePages.push({ ...cursor });
        // Site-global sequence 1..10; only FAB-A rows 1,3,5,7 are part of this
        // FAB's page. FAB-B rows are never returned by a FAB-filtered endpoint.
        return {
          epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 1, latestSequence: 10,
          events: [
            { sequence: 1, fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: 'now' },
            { sequence: 3, fabId: 'fab-a', commandId: 'cmd-1', revision: 3, outcome: 'executing', occurredAt: 'now' },
            { sequence: 5, fabId: 'fab-a', commandId: 'cmd-1', revision: 5, outcome: 'executing', occurredAt: 'now' },
            { sequence: 7, fabId: 'fab-a', commandId: 'cmd-1', revision: 7, outcome: 'succeeded', occurredAt: 'now' },
          ],
          nextAfterSequence: 10,
        } as CommandJournalPage;
      },
    });
    const created = fab({ source, gateway });
    created.runtime.start();
    created.runtime.trackCommand('cmd-1');
    await expect.poll(() => created.runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
    const listCallsBefore = gateway.listCalls.length;
    emitDirty(source, { reason: 'overflow', droppedCount: 4, delivered: { epoch: 'epoch-1', sequence: 0 }, gapStart: 1 });
    await expect.poll(() => created.runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(7);
    expect(created.runtime.getProjection('cmd-1')?.outcome).toBe('succeeded');
    // One page was enough: nextAfterSequence (10) reached latestSequence (10); the
    // sparse FAB sequence was never interpreted as a hole and needed no list.
    expect(sparsePages).toHaveLength(1);
    expect(sparsePages[0]?.afterSequence).toBe(0);
    expect(gateway.listCalls.length).toBe(listCallsBefore);
  });
});
