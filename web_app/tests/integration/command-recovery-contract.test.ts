import { afterEach, expect, it } from 'vitest';
import type { CommandJournalPage, CommandJournalQuery } from '@/contracts/command-gateway.contract';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';
import type { TestFab } from '../support/command-fakes.ts';
import {
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

it('evicts a non-terminal event before a terminal one and reports diagnostics', () => {
  const evictions: unknown[] = [];
  const recovery = new CommandEventRecovery({ maxTotal: 2, onEvict: (eviction) => evictions.push(eviction) });
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'terminal', revision: 1, outcome: 'succeeded' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'pending-a', revision: 1, outcome: 'executing' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'pending-b', revision: 1, outcome: 'accepted' }));
  expect(recovery.pendingFor('fab', 'terminal')).toHaveLength(1);
  expect(recovery.droppedCount).toBe(1);
  expect(recovery.diagnostics).toHaveLength(1);
  expect(recovery.diagnostics[0]).toMatchObject({ reason: 'global', terminal: false });
  expect(evictions).toHaveLength(1);
});

it('prefers non-terminal events for per-command overflow too', () => {
  const recovery = new CommandEventRecovery({ maxPerCommand: 2 });
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'cmd', revision: 3, outcome: 'succeeded' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'cmd', revision: 1, outcome: 'executing' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'cmd', revision: 2, outcome: 'accepted' }));
  expect(recovery.pendingFor('fab', 'cmd').map((event) => event.revision)).toEqual([3, 2]);
  expect(recovery.diagnostics[0]).toMatchObject({ reason: 'per-command', terminal: false });
});

it('turns a capacity eviction into a coalesced authoritative reconciliation', async () => {
  const source = new FakeCommandEventSource();
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) =>
      commandResult({ fabId, commandId, revision: 5, outcome: 'succeeded' }),
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  runtime.registerAcceptedCommand('cmd-1');
  await Promise.resolve();
  const listCallsBefore = gateway.listCalls.length;
  // 300 uncorrelated terminal results overflow the 256-entry recovery queue.
  for (let index = 0; index < 300; index += 1) {
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'other-' + index, revision: 1, outcome: 'succeeded' }));
  }
  expect(runtime.recoveryDroppedCount).toBeGreaterThan(0);
  expect(runtime.lastRecoveryEviction).toBeDefined();
  // ADR-010 R3: an eviction keeps Dirty and the authoritative list is the recovery
  // entry point; there is no silent per-command status sweep.
  await expect.poll(() => gateway.listCalls.length, { timeout: 1_000 }).toBeGreaterThan(listCallsBefore);
  expect(runtime.recoveryState.phase).toBe('Healthy');
});

it('R3-01: rejects an empty journal page older than the retained window and recovers from the list', async () => {
  const source = new FakeCommandEventSource();
  let listAttempts = 0;
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 4, outcome: 'executing' }),
    // An old/defective backend answers a stale cursor with hasGap=false and an
    // empty page. The frontend must NOT treat that as "already recovered".
    getCommandJournalPage: async (): Promise<CommandJournalPage> => ({
      epoch: 'epoch-1',
      hasGap: false,
      firstRetainedSequence: 7,
      latestSequence: 6,
      events: [],
      nextAfterSequence: 0,
    }),
    listFabCommands: async () => {
      listAttempts += 1;
      return listAttempts === 1
        ? emptyRecoveryList()
        : emptyRecoveryList([
          commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 4, outcome: 'executing' }),
        ]);
    },
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.registerAcceptedCommand('cmd-1');
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
  const listCallsBefore = gateway.listCalls.length;

  source.emitDirty({
    reason: 'overflow',
    droppedCount: 2,
    delivered: { epoch: 'epoch-1', sequence: 0 },
    gapStart: 1,
  });

  // The cursor (0) is before firstRetainedSequence-1 (6): the page is a protocol
  // violation, so the authoritative list is applied instead of an empty success.
  await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 1_000 }).toBe(4);
  expect(gateway.journalCalls.length).toBeGreaterThanOrEqual(1);
  expect(gateway.listCalls.length).toBeGreaterThan(listCallsBefore);
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
  expect(runtime.recoveryState.needsNextAuthoritativePass).toBe(false);
  expect(runtime.recoveryHistory.some((entry) => entry.cause === 'replay-gap')).toBe(true);
});

it('R3-03: accepts a FAB-filtered sparse Site page (FAB-A 1,3,5,7) as authoritative', async () => {
  const source = new FakeCommandEventSource();
  const journalQueries: CommandJournalQuery[] = [];
  const gateway = fakeCommandGateway({
    getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 4, outcome: 'executing' }),
    // Site-global sequence, FAB-A filtered page: 1,3,5,7. Sequences 2,4,6,8..10
    // belong to other FABs and are intentionally absent from this response.
    getCommandJournalPage: async (_siteId, _fabId, query): Promise<CommandJournalPage> => {
      journalQueries.push(query);
      return {
        epoch: 'epoch-1',
        hasGap: false,
        firstRetainedSequence: 1,
        latestSequence: 10,
        events: [
          { sequence: 1, fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'accepted', occurredAt: '2026-10-30T00:00:00.000Z' },
          { sequence: 3, fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing', occurredAt: '2026-10-30T00:00:01.000Z' },
          { sequence: 5, fabId: 'fab-a', commandId: 'cmd-1', revision: 3, outcome: 'executing', occurredAt: '2026-10-30T00:00:02.000Z' },
          { sequence: 7, fabId: 'fab-a', commandId: 'cmd-1', revision: 4, outcome: 'executing', occurredAt: '2026-10-30T00:00:03.000Z' },
        ],
        nextAfterSequence: 10,
      };
    },
    listFabCommands: async () => emptyRecoveryList(),
  });
  const fab = createTestFab({ source, gateway });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.registerAcceptedCommand('cmd-1');
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
  const listCallsBefore = gateway.listCalls.length;

  source.emitDirty({
    reason: 'overflow',
    droppedCount: 4,
    delivered: { epoch: 'epoch-1', sequence: 0 },
    gapStart: 1,
  });

  await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 1_000 }).toBe(4);
  expect(runtime.getProjection('cmd-1')?.outcome).toBe('executing');
  expect(runtime.lastJournalPage?.events.map((event) => event.sequence)).toEqual([1, 3, 5, 7]);
  expect(journalQueries[0]).toMatchObject({ epoch: 'epoch-1', afterSequence: 0 });
  // The sparse page itself is complete: no authoritative list fallback.
  expect(gateway.listCalls.length).toBe(listCallsBefore);
  await expect.poll(() => runtime.recoveryState.phase, { timeout: 1_000 }).toBe('Healthy');
  // R3-02 seam: the authoritative watermark was signed to the transport ledger.
  await expect.poll(() => source.cursors.acknowledged, { timeout: 1_000 }).toEqual({ epoch: 'epoch-1', sequence: 10 });
});
