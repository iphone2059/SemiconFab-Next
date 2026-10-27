import { expect, it } from 'vitest';
import { CommandEventRecovery } from '../../src/application/coordination/CommandEventRecovery';
import type { CommandGateway } from '../../src/application/contracts/CommandGateway';
import { commandResult } from '../support/command-fakes';

const event = (fabId: string, commandId: string, revision: number) =>
  commandResult({ fabId, commandId, revision, outcome: 'executing' });

it('bounds the pending queue per command and overall, keeping the newest revisions', () => {
  const recovery = new CommandEventRecovery({ maxPerCommand: 2, maxTotal: 3 });
  recovery.hold(event('fab', 'cmd', 1));
  recovery.hold(event('fab', 'cmd', 2));
  recovery.hold(event('fab', 'cmd', 3));
  expect(recovery.pendingFor('fab', 'cmd').map((value) => value.revision)).toEqual([2, 3]);
  expect(recovery.droppedCount).toBe(1);

  recovery.hold(event('fab', 'cmd-b', 1));
  recovery.hold(event('fab', 'cmd-c', 1));
  // maxTotal=3: the oldest held event is dropped first.
  expect(recovery.pendingFor('fab', 'cmd').map((value) => value.revision)).toEqual([3]);
  expect(recovery.size).toBe(3);
});

it('replaces a duplicate revision instead of growing the queue', () => {
  const recovery = new CommandEventRecovery();
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'cmd', revision: 2, outcome: 'executing' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'cmd', revision: 2, outcome: 'failed' }));
  expect(recovery.pendingFor('fab', 'cmd')).toHaveLength(1);
  expect(recovery.pendingFor('fab', 'cmd')[0].outcome).toBe('failed');
  expect(recovery.size).toBe(1);
});

it('does not evict real events after repeatedly replacing the same revision', () => {
  const recovery = new CommandEventRecovery({ maxTotal: 2 });
  for (let index = 0; index < 3; index++) recovery.hold(event('fab', 'cmd', 1));
  recovery.hold(event('fab', 'other', 1));
  expect(recovery.size).toBe(2);
  expect(recovery.pendingFor('fab', 'cmd')).toHaveLength(1);
  expect(recovery.pendingFor('fab', 'other')).toHaveLength(1);
  expect(recovery.droppedCount).toBe(0);
});

it('drains in arrival order and can reconcile through the authoritative gateway', async () => {
  const recovery = new CommandEventRecovery();
  expect(recovery.drain()).toEqual([]);
  const gateway: CommandGateway = {
    getCommandStatus: async () => commandResult({ fabId: 'fab', commandId: 'cmd', revision: 4, outcome: 'succeeded' }),
  };
  const authoritative = await recovery.reconcile(gateway, 'fab', 'cmd');
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

it('clears on dispose so a stopped runtime leaks no pending events', () => {
  const recovery = new CommandEventRecovery();
  recovery.hold(event('fab', 'cmd', 1));
  recovery.dispose();
  expect(recovery.size).toBe(0);
  expect(recovery.drain()).toEqual([]);
});
