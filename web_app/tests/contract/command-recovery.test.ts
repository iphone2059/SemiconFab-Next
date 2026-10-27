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

it('clears on dispose so a stopped runtime leaks no pending events', () => {
  const recovery = new CommandEventRecovery();
  recovery.hold(event('fab', 'cmd', 1));
  recovery.dispose();
  expect(recovery.size).toBe(0);
  expect(recovery.drain()).toEqual([]);
});
