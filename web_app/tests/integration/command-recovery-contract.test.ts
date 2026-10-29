import { afterEach, expect, it } from 'vitest';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';
import type { TestFab } from '../support/command-fakes.ts';
import {
  FakeCommandEventSource,
  commandResult,
  createTestFab,
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
  runtime.trackCommand('cmd-1');
  await Promise.resolve();
  const listCallsBefore = gateway.listCalls.length;
  // 300 uncorrelated terminal results overflow the 256-entry recovery queue.
  for (let index = 0; index < 300; index += 1) {
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'other-' + index, revision: 1, outcome: 'succeeded' }));
  }
  expect(runtime.recoveryDroppedCount).toBeGreaterThan(0);
  expect(runtime.lastRecoveryEviction).toBeDefined();
  // ADR-010 §4: an eviction keeps Dirty and the authoritative list is the recovery
  // entry point; there is no silent per-command status sweep.
  await expect.poll(() => gateway.listCalls.length, { timeout: 1_000 }).toBeGreaterThan(listCallsBefore);
  expect(runtime.recoveryState.phase).toBe('Healthy');
});
