import { describe, expect, it } from 'vitest';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes.ts';

const commandId = 'cmd-1';

function adapter(runtime: { getWorkflow(id: string): unknown }): XStateCommandWorkflowAdapter {
  const workflow = runtime.getWorkflow(commandId);
  if (!(workflow instanceof XStateCommandWorkflowAdapter)) throw new Error('expected XState adapter');
  return workflow;
}

describe('FabRuntime single-FAB assembly (CE-07)', () => {
  it('replaces the FAB runtime without carrying its old workflow or source into the new generation', () => {
    const oldSource = new FakeCommandEventSource();
    const newSource = new FakeCommandEventSource();
    const registry = new FabRuntimeRegistry();
    const first = new FabRuntimeFactory({ sourceFor: () => oldSource }).create('fab-a');
    registry.register(first);
    expect(registry.size).toBe(1);
    expect(registry.fabIds).toEqual(['fab-a']);
    registry.startAll();
    const oldWorkflow = first.trackCommand(commandId);
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 5, outcome: 'executing' }));
    expect(adapter(first).state).toBe('executing');

    expect(registry.remove('fab-a')).toBe(first);
    expect(oldSource.commandObservers).toBe(0);
    const current = new FabRuntimeFactory({ sourceFor: () => newSource }).create('fab-a');
    registry.register(current);
    registry.startAll();
    expect(current.trackCommand(commandId)).not.toBe(oldWorkflow);
    expect(current.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 6, outcome: 'succeeded' }));
    newSource.emit(commandResult({ fabId: 'unknown-fab', commandId, revision: 9, outcome: 'succeeded' }));
    expect(current.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(current).context).toMatchObject({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' });
    expect(adapter(current).state).toBe('executing');
    expect(registry.size).toBe(1);
    registry.disposeAll();
    expect(registry.size).toBe(0);
    expect(newSource.commandObservers).toBe(0);
  });
});

describe('FabRuntime reconciliation and lifecycle (CE-06/CE-08)', () => {
  it('recovers a terminal result evicted before HTTP submission registers its workflow', async () => {
    const source = new FakeCommandEventSource();
    const gateway: CommandGateway = { getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }) };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    for (let index = 0; index < 256; index++) source.emit(commandResult({ fabId: 'fab-a', commandId: `other-${index}`, revision: 2, outcome: 'succeeded' }));
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 150 }).toBe('succeeded');
    runtime.dispose();
  });

  it('automatically reconciles active commands when the source reconnects', async () => {
    const source = new FakeCommandEventSource();
    let outcome: 'accepted' | 'succeeded' = 'accepted';
    const gateway: CommandGateway = { getCommandStatus: async (fabId, commandId) => commandResult({ fabId, commandId, revision: outcome === 'accepted' ? 0 : 2, outcome }) };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
    runtime.start(); runtime.trackCommand(commandId);
    await runtime.reconcileCommand(commandId);
    outcome = 'succeeded'; source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 150 }).toBe('succeeded');
    runtime.dispose();
  });

  it('coalesces authoritative queries and ignores their results after disposal', async () => {
    const source = new FakeCommandEventSource();
    let complete!: (event: ReturnType<typeof commandResult>) => void;
    let queries = 0;
    const gateway: CommandGateway = { getCommandStatus: () => { queries++; return new Promise(resolve => { complete = resolve; }); } };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
    runtime.start(); runtime.trackCommand(commandId);
    const pending = runtime.reconcileCommand(commandId);
    const concurrent = runtime.reconcileCommand(commandId);
    expect(queries).toBe(1);
    runtime.dispose();
    complete(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect(pending).resolves.toBe(false);
    await expect(concurrent).resolves.toBe(false);
    expect(queries).toBe(1);
    expect(runtime.getProjection(commandId)).toBeUndefined();
  });

  it('contains failed background recovery and retries when the connection returns', async () => {
    const source = new FakeCommandEventSource();
    let available = false;
    const gateway: CommandGateway = { getCommandStatus: async (fabId, commandId) => {
      if (!available) throw new Error('offline');
      return commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' });
    } };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
    runtime.start(); runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
    available = true; source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 150 }).toBe('succeeded');
    runtime.dispose();
  });

  it('converges through the authoritative gateway after the stream stops (CE-06)', async () => {
    const source = new FakeCommandEventSource();
    const gateway: CommandGateway = {
      getCommandStatus: async () => commandResult({ fabId: 'fab-a', commandId, revision: 3, outcome: 'succeeded' }),
    };
    const runtime = new FabRuntimeFactory({ sourceFor: () => source, gateway }).create('fab-a');
    runtime.start();
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    runtime.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(runtime).state).toBe('accepted');
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(true);
    expect(adapter(runtime).state).toBe('succeeded');
    runtime.dispose();
  });

  it('replays results that arrive before trackCommand created the workflow (CE-04 runtime path)', () => {
    const source = new FakeCommandEventSource();
    const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create('fab-a');
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'succeeded' }));
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.trackCommand(commandId)).toBeInstanceOf(XStateCommandWorkflowAdapter);
    expect(adapter(runtime).state).toBe('succeeded');
    expect(runtime.pendingCount).toBe(0);
    runtime.dispose();
  });

  it('stops delivery and disposes workflows/runtimes on lifecycle shutdown (CE-08)', () => {
    const source = new FakeCommandEventSource();
    const registry = new FabRuntimeRegistry();
    registry.register(new FabRuntimeFactory({ sourceFor: () => source }).create('fab-a'));
    const lifecycle = new FabLifecycleCoordinator(registry);
    lifecycle.start();
    registry.get('fab-a')!.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    lifecycle.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(registry.get('fab-a')!).state).toBe('accepted');
    lifecycle.dispose();
    expect(registry.size).toBe(0);
    expect(lifecycle.running).toBe(false);
  });

  it('exposes read-only workflow projections and notifies UI subscribers', () => {
    const source = new FakeCommandEventSource();
    const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create('fab-a');
    const notifications: number[] = [];
    runtime.subscribe(() => notifications.push(notifications.length));
    runtime.start();
    runtime.trackCommand(commandId);
    expect(runtime.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1, outcome: 'pending' });
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    expect(runtime.getProjection(commandId)).toMatchObject({ state: 'accepted', revision: 1, outcome: 'accepted' });
    expect(notifications.length).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('exposes reconcileCommand only when a gateway is assembled', async () => {
    const source = new FakeCommandEventSource();
    const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create('fab-a');
    runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
    runtime.dispose();
  });
});
