import { expect, it } from 'vitest';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes.ts';

it('evicts a non-terminal event before a terminal one and reports diagnostics', () => {
  const evictions: unknown[] = [];
  const recovery = new CommandEventRecovery({ maxTotal: 2, onEvict: (eviction) => evictions.push(eviction) });
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'terminal', revision: 1, outcome: 'succeeded' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'pending-a', revision: 1, outcome: 'executing' }));
  recovery.hold(commandResult({ fabId: 'fab', commandId: 'pending-b', revision: 1, outcome: 'accepted' }));
  // The terminal result arrived first but must survive; a non-terminal event is evicted.
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
  let queries = 0;
  const gateway = { getCommandStatus: async (fabId: string, commandId: string) => {
    queries += 1;
    return commandResult({ fabId, commandId, revision: 5, outcome: 'succeeded' });
  } };
  const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
  runtime.start();
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  runtime.trackCommand('cmd-1');
  await Promise.resolve();
  const before = queries;
  // 300 uncorrelated terminal results overflow the 256-entry recovery queue.
  for (let index = 0; index < 300; index += 1) {
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'other-' + index, revision: 1, outcome: 'succeeded' }));
  }
  expect(runtime.recoveryDroppedCount).toBeGreaterThan(0);
  expect(runtime.lastRecoveryEviction).toBeDefined();
  await expect.poll(() => queries, { timeout: 300 }).toBeGreaterThan(before);
  runtime.dispose();
});
