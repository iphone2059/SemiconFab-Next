import { Effect } from 'effect';
import type { CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import { describe, expect, it } from 'vitest';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';
import { CommandConfigurationError } from '@/contracts/command-config';
import { commandResult, fakeCommandGateway } from '../support/command-fakes.ts';

/** Approved execution boundary for this contract test (no application singleton). */
const run = (effect: Effect.Effect<CommandResultEvent | null, CommandGatewayError>): Promise<CommandResultEvent | null> =>
  Effect.runPromise(effect);

const event = (fabId: string, commandId: string, revision: number) =>
  commandResult({ fabId, commandId, revision, outcome: 'executing' });

const outcomeEvent = (fabId: string, commandId: string, revision: number, outcome: CommandResultEvent['outcome']) =>
  commandResult({ fabId, commandId, revision, outcome });

it('bounds the pending queue per command and overall, keeping the newest revisions', () => {
  const recovery = new CommandEventRecovery({ maxPerCommand: 2, maxTotal: 3 });
  expect(recovery.hold(event('fab', 'cmd', 1))).toBe('inserted');
  expect(recovery.hold(event('fab', 'cmd', 2))).toBe('inserted');
  expect(recovery.hold(event('fab', 'cmd', 3))).toBe('inserted');
  expect(recovery.pendingFor('fab', 'cmd').map((value) => value.revision)).toEqual([2, 3]);
  expect(recovery.droppedCount).toBe(1);

  recovery.hold(event('fab', 'cmd-b', 1));
  recovery.hold(event('fab', 'cmd-c', 1));
  // maxTotal=3: the oldest held event is dropped first.
  expect(recovery.pendingFor('fab', 'cmd').map((value) => value.revision)).toEqual([3]);
  expect(recovery.size).toBe(3);
});

it('same revision with a different outcome is a conflict and never overwrites the held event', () => {
  const recovery = new CommandEventRecovery();
  const first = outcomeEvent('fab', 'cmd', 2, 'executing');
  const conflicting = outcomeEvent('fab', 'cmd', 2, 'failed');
  expect(recovery.hold(first)).toBe('inserted');
  // Identical outcome => duplicate (no new record).
  expect(recovery.hold(outcomeEvent('fab', 'cmd', 2, 'executing'))).toBe('duplicate');
  // Different outcome => conflict: reported but not inserted/overwritten.
  expect(recovery.hold(conflicting)).toBe('conflict');
  expect(recovery.pendingFor('fab', 'cmd')).toEqual([first]);
  // A hold-level conflict is not a bridge conflict record: the bridge calls
  // holdConflict() when correlation already flagged the conflict.
  expect(recovery.conflictCount).toBe(0);
  expect(recovery.size).toBe(1);
});

it('does not evict real events after repeatedly replacing the same revision', () => {
  const recovery = new CommandEventRecovery({ maxTotal: 2 });
  for (let index = 0; index < 3; index++) expect(recovery.hold(event('fab', 'cmd', 1))).toBe(index === 0 ? 'inserted' : 'duplicate');
  recovery.hold(event('fab', 'other', 1));
  expect(recovery.size).toBe(2);
  expect(recovery.pendingFor('fab', 'cmd')).toHaveLength(1);
  expect(recovery.pendingFor('fab', 'other')).toHaveLength(1);
  expect(recovery.droppedCount).toBe(0);
});

it('drains in arrival order and can reconcile through the authoritative gateway', async () => {
  const recovery = new CommandEventRecovery();
  expect(recovery.drain()).toEqual([]);
  const gateway = fakeCommandGateway({
    getCommandStatus: async () => commandResult({ fabId: 'fab', commandId: 'cmd', revision: 4, outcome: 'succeeded' }),
  });
  const authoritative = await recovery.reconcile(gateway, 'fab', 'cmd', run);
  expect(authoritative?.outcome).toBe('succeeded');
  expect(recovery.pendingFor('fab', 'cmd')).toHaveLength(1);
  expect(recovery.drain().map((value) => value.revision)).toEqual([4]);
  expect(recovery.size).toBe(0);
});

it('evicts the true globally oldest event instead of the first-seen command head', () => {
  const recovery = new CommandEventRecovery({ maxTotal: 2 });
  recovery.hold(event('fab', 'A', 0));
  recovery.hold(event('fab', 'B', 0));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'A', revision: 1, outcome: 'succeeded' }));
  // A:0/B:0/A:1 is 3 held events for maxTotal=2, so the globally oldest A:0 is
  // evicted; the newer A:1 terminal must survive even though it was grouped
  // behind the same first-seen command queue.
  expect(recovery.pendingFor('fab', 'A').map((value) => value.revision)).toEqual([1]);
  expect(recovery.pendingFor('fab', 'B').map((value) => value.revision)).toEqual([0]);
  recovery.hold(event('fab', 'C', 0));
  // Now B:0 is the globally oldest and is evicted by C:0, per the documented FIFO.
  expect(recovery.pendingFor('fab', 'B')).toEqual([]);
  expect(recovery.pendingFor('fab', 'A').map((value) => value.revision)).toEqual([1]);
  expect(recovery.pendingFor('fab', 'C').map((value) => value.revision)).toEqual([0]);
  expect(recovery.size).toBe(2);
  expect(recovery.droppedCount).toBe(2);
});

it('drains in true global arrival order across commands, not grouped by command', () => {
  const recovery = new CommandEventRecovery();
  const placed = [
    commandResult({ fabId: 'fab', commandId: 'A', revision: 0, outcome: 'executing' }),
    commandResult({ fabId: 'fab', commandId: 'B', revision: 0, outcome: 'executing' }),
    commandResult({ fabId: 'fab', commandId: 'A', revision: 1, outcome: 'succeeded' }),
    commandResult({ fabId: 'fab', commandId: 'C', revision: 0, outcome: 'accepted' }),
    commandResult({ fabId: 'fab', commandId: 'B', revision: 1, outcome: 'succeeded' }),
  ];
  for (const held of placed) recovery.hold(held);
  expect(recovery.drain()).toEqual(placed);
  expect(recovery.size).toBe(0);
});

it('snapshot/release read the queue without draining it, so a retry pass never loses events (R4-03)', () => {
  const recovery = new CommandEventRecovery();
  const first = event('fab', 'cmd', 1);
  const second = event('fab', 'cmd', 2);
  recovery.hold(first);
  recovery.hold(second);
  // A retry pass snapshots first; pending events stay held until they are applied.
  expect(recovery.snapshot()).toEqual([first, second]);
  expect(recovery.size).toBe(2);
  expect(recovery.release(first)).toBe(true);
  expect(recovery.release(first)).toBe(false);
  expect(recovery.pendingFor('fab', 'cmd')).toEqual([second]);
  expect(recovery.droppedCount).toBe(0);
});

it('R4-07: invalid recovery bounds fail fast at construction', () => {
  expect(() => new CommandEventRecovery({ maxPerCommand: 0 })).toThrow(CommandConfigurationError);
  expect(() => new CommandEventRecovery({ maxTotal: Number.NaN })).toThrow(CommandConfigurationError);
  expect(() => new CommandEventRecovery({ maxTotal: 2.5 })).toThrow(CommandConfigurationError);
  expect(() => new CommandEventRecovery({ maxConflicts: 0 })).toThrow(CommandConfigurationError);
  expect(() => new CommandEventRecovery({ maxConflicts: Number.POSITIVE_INFINITY })).toThrow(CommandConfigurationError);
});

it('clears on dispose so a stopped runtime leaks no pending events', () => {
  const recovery = new CommandEventRecovery();
  recovery.hold(event('fab', 'cmd', 1));
  recovery.holdConflict(outcomeEvent('fab', 'cmd', 1, 'failed'));
  recovery.dispose();
  expect(recovery.size).toBe(0);
  expect(recovery.conflictCount).toBe(0);
  expect(recovery.drain()).toEqual([]);
});

describe('Round 5.1 / P1-02 unresolved conflict records', () => {
  it('holdConflict records the conflict, its held original and participates in size/pendingCount', () => {
    const recovery = new CommandEventRecovery();
    const original = outcomeEvent('fab', 'cmd', 2, 'accepted');
    const conflicting = outcomeEvent('fab', 'cmd', 2, 'failed');
    expect(recovery.hold(original)).toBe('inserted');
    const conflict = recovery.holdConflict(conflicting);
    expect(conflict).toMatchObject({ fabId: 'fab', commandId: 'cmd', revision: 2, event: conflicting, held: original });
    expect(recovery.conflictCount).toBe(1);
    // size = normal held events + conflicts (the recovery barrier counts both).
    expect(recovery.size).toBe(2);
    expect(recovery.conflicts).toHaveLength(1);
    expect(recovery.conflicts[0]).toBe(conflict);
  });

  it('records a conflict whose original event was already applied/released', () => {
    const recovery = new CommandEventRecovery();
    const original = outcomeEvent('fab', 'cmd', 3, 'accepted');
    const conflicting = outcomeEvent('fab', 'cmd', 3, 'failed');
    recovery.hold(original);
    expect(recovery.release(original)).toBe(true);
    const conflict = recovery.holdConflict(conflicting);
    expect(conflict.held).toBeUndefined();
    expect(recovery.conflictCount).toBe(1);
    expect(recovery.size).toBe(1);
  });

  it('deduplicates a repeated identical conflicting frame', () => {
    const recovery = new CommandEventRecovery();
    const conflicting = outcomeEvent('fab', 'cmd', 2, 'failed');
    const first = recovery.holdConflict(conflicting);
    const second = recovery.holdConflict(conflicting);
    expect(second).toBe(first);
    expect(recovery.conflictCount).toBe(1);
    expect(recovery.size).toBe(1);
  });

  it('never returns conflict records from snapshot/drain/pendingFor', () => {
    const recovery = new CommandEventRecovery({ maxTotal: 1 });
    const held = event('fab', 'cmd', 1);
    recovery.hold(held);
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 1, 'failed'));
    // conflicts participate in size (barrier) but are not part of the event FIFO.
    expect(recovery.size).toBe(2);
    expect(recovery.snapshot()).toEqual([held]);
    expect(recovery.pendingFor('fab', 'cmd')).toEqual([held]);
    expect(recovery.drain()).toEqual([held]);
    // drain only removes normal held events; the unresolved conflict remains.
    expect(recovery.size).toBe(1);
    expect(recovery.conflictCount).toBe(1);
  });

  it('conflicts do not consume the normal event capacity (maxTotal applies to events only)', () => {
    const recovery = new CommandEventRecovery({ maxTotal: 1, maxPerCommand: 1 });
    recovery.hold(event('fab', 'cmd-a', 1));
    recovery.holdConflict(outcomeEvent('fab', 'cmd-b', 1, 'failed'));
    recovery.holdConflict(outcomeEvent('fab', 'cmd-c', 1, 'failed'));
    expect(recovery.pendingFor('fab', 'cmd-a')).toHaveLength(1);
    expect(recovery.conflictCount).toBe(2);
    expect(recovery.size).toBe(3);
    expect(recovery.droppedCount).toBe(0);
  });

  it('bounds the conflict records and keeps the dropped-count accounting observable', () => {
    const recovery = new CommandEventRecovery({ maxConflicts: 2 });
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 1, 'failed'));
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 2, 'failed'));
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 3, 'failed'));
    expect(recovery.conflictCount).toBe(2);
    expect(recovery.conflicts.map((conflict) => conflict.revision)).toEqual([2, 3]);
    expect(recovery.droppedCount).toBe(1);
    expect(recovery.size).toBe(2);
  });

  it('resolveAuthoritative clears conflicts at or below the authoritative revision only', () => {
    const recovery = new CommandEventRecovery();
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 2, 'failed'));
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 6, 'failed'));
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 2, 'cancelled'));
    recovery.holdConflict(outcomeEvent('fab', 'other', 2, 'failed'));
    expect(recovery.conflictCount).toBe(4);
    expect(recovery.resolveAuthoritative(outcomeEvent('fab', 'cmd', 4, 'executing'))).toBe(2);
    expect(recovery.conflicts.map((conflict) => [conflict.commandId, conflict.revision])).toEqual([
      ['cmd', 6],
      ['other', 2],
    ]);
    expect(recovery.conflictCount).toBe(2);
    expect(recovery.size).toBe(2);
    expect(recovery.resolveAuthoritative(outcomeEvent('fab', 'cmd', 6, 'succeeded'))).toBe(1);
    expect(recovery.conflicts.map((conflict) => [conflict.commandId, conflict.revision])).toEqual([['other', 2]]);
    expect(recovery.resolveAuthoritative(outcomeEvent('fab', 'missing', 9, 'succeeded'))).toBe(0);
  });

  it('clear() clears conflicts together with held events', () => {
    const recovery = new CommandEventRecovery();
    recovery.hold(event('fab', 'cmd', 1));
    recovery.holdConflict(outcomeEvent('fab', 'cmd', 1, 'failed'));
    expect(recovery.size).toBe(2);
    recovery.clear();
    expect(recovery.size).toBe(0);
    expect(recovery.conflictCount).toBe(0);
    expect(recovery.conflicts).toEqual([]);
    expect(recovery.snapshot()).toEqual([]);
    expect(recovery.drain()).toEqual([]);
  });

  it('holds a conflicting authoritative reconcile result instead of duplicating the event', async () => {
    const recovery = new CommandEventRecovery();
    recovery.hold(outcomeEvent('fab', 'cmd', 2, 'accepted'));
    const gateway = fakeCommandGateway({
      getCommandStatus: async () => outcomeEvent('fab', 'cmd', 2, 'failed'),
    });
    // reconcile() keeps the existing hold semantics: the conflicting authoritative
    // result does not overwrite the held event (the owner applies authority first).
    await recovery.reconcile(gateway, 'fab', 'cmd', run);
    expect(recovery.pendingFor('fab', 'cmd').map((held) => held.outcome)).toEqual(['accepted']);
    expect(recovery.size).toBe(1);
  });
});
