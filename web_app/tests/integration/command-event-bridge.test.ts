import { describe, expect, it } from 'vitest';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import {
  FakeCommandEventSource,
  FakeCommandWorkflow,
  FakeWorkflowRegistry,
  commandResult,
} from '../support/command-fakes.ts';

const fabId = 'fab-a';
const commandId = 'cmd-1';

function setup(options: { fabId?: string } = {}) {
  const source = new FakeCommandEventSource();
  const workflows = new FakeWorkflowRegistry();
  const workflow = new FakeCommandWorkflow();
  const bridge = new CommandEventBridge(source, workflows, { fabId: options.fabId });
  return { source, workflows, workflow, bridge };
}

describe('CommandEventBridge (CE-01..CE-05)', () => {
  it('CE-01 delivers accepted/executing/succeeded in order to the registered workflow', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    for (const [revision, outcome] of [[1, 'accepted'], [2, 'executing'], [3, 'succeeded']] as const) {
      source.emit(commandResult({ fabId, commandId, revision, outcome }));
    }
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([
      [1, 'accepted'],
      [2, 'executing'],
      [3, 'succeeded'],
    ]);
    expect(bridge.pendingCount).toBe(0);
  });

  it('CE-02 filters a duplicate revision without advancing the workflow twice', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    const event = commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' });
    source.emit(event);
    source.emit({ ...event, outcome: 'succeeded' });
    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0].outcome).toBe('accepted');
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(1);
  });

  it('CE-03 ignores an out-of-order revision and never regresses state', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    expect(workflow.events.map((event) => event.revision)).toEqual([2]);
    expect(bridge.correlationRegistry.lastRevision(fabId, commandId)).toBe(2);
  });

  it('CE-04 keeps a confirmation that arrives before the HTTP response and correlates it later', () => {
    const { source, workflows, workflow, bridge } = setup();
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'succeeded' }));
    expect(workflow.events).toHaveLength(0);
    expect(bridge.pendingCount).toBe(1);
    // The submit response eventually creates the workflow; the held result is replayed once.
    workflows.register(fabId, commandId, workflow);
    expect(bridge.flushRecovery()).toBe(1);
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([[1, 'succeeded']]);
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'cancelled' }));
    expect(workflow.events).toHaveLength(2);
  });

  it('CE-05 recovers an unknown actor through the authoritative command gateway', async () => {
    const { source, workflows, workflow, bridge } = setup();
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    expect(bridge.pendingCount).toBe(1);

    const gateway: CommandGateway = {
      getCommandStatus: async () => commandResult({ fabId, commandId, revision: 3, outcome: 'succeeded' }),
    };
    workflows.register(fabId, commandId, workflow);
    await expect(bridge.reconcile(gateway, fabId, commandId)).resolves.toBe(2);
    expect(workflow.events.map((event) => [event.revision, event.outcome])).toEqual([
      [2, 'executing'],
      [3, 'succeeded'],
    ]);
    expect(bridge.pendingCount).toBe(0);
  });

  it('filters events from another FAB by composite identity', () => {
    const { source, workflows, workflow, bridge } = setup({ fabId: 'fab-b' });
    workflows.register('fab-b', commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    source.emit(commandResult({ fabId: 'fab-b', commandId, revision: 1, outcome: 'accepted' }));
    expect(workflow.events.map((event) => event.fabId)).toEqual(['fab-b']);
  });
});

describe('CommandEventBridge lifecycle (CE-08)', () => {
  it('stops delivering after start/stop and clears pending recovery state', () => {
    const { source, workflows, workflow, bridge } = setup();
    workflows.register(fabId, commandId, workflow);
    bridge.start();
    source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
    bridge.stop();
    source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }));
    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0].revision).toBe(1);

    source.emit(commandResult({ fabId: 'fab-a', commandId: 'unknown', revision: 1, outcome: 'failed' }));
    expect(bridge.pendingCount).toBe(0);
    bridge.dispose();
    expect(bridge.pendingCount).toBe(0);
  });
});
