import { describe, expect, it } from 'vitest';
import type { CommandGateway } from '../../src/application/contracts/CommandGateway';
import { XStateCommandWorkflowAdapter } from '../../src/runtime/commands/XStateCommandWorkflowAdapter';
import { FabLifecycleCoordinator } from '../../src/runtime/FabLifecycleCoordinator';
import { FabRuntimeFactory } from '../../src/runtime/FabRuntimeFactory';
import { FabRuntimeRegistry } from '../../src/runtime/FabRuntimeRegistry';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes';

const commandId = 'cmd-1';

function adapter(runtime: { getWorkflow(id: string): unknown }): XStateCommandWorkflowAdapter {
  const workflow = runtime.getWorkflow(commandId);
  if (!(workflow instanceof XStateCommandWorkflowAdapter)) throw new Error('expected XState adapter');
  return workflow;
}

describe('FabRuntime multi-FAB assembly (CE-07)', () => {
  it('keeps the same commandId isolated per FAB with one runtime per FAB', () => {
    const sources = new Map(['fab-a', 'fab-b', 'fab-c'].map((fabId) => [fabId, new FakeCommandEventSource()] as const));
    const factory = new FabRuntimeFactory({ sourceFor: (fabId) => sources.get(fabId)! });
    const registry = new FabRuntimeRegistry();
    for (const fabId of sources.keys()) registry.register(factory.create(fabId));
    expect(registry.size).toBe(3);
    expect(registry.fabIds).toEqual(['fab-a', 'fab-b', 'fab-c']);
    registry.startAll();

    const workflows = new Map([...sources.keys()].map((fabId) => [fabId, registry.get(fabId)!.trackCommand(commandId)]));
    for (const [fabId, source] of sources) {
      source.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
      source.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
    }
    for (const fabId of sources.keys()) {
      const workflow = workflows.get(fabId)!;
      expect(workflow).toBeInstanceOf(XStateCommandWorkflowAdapter);
      const state = adapter(registry.get(fabId)!);
      expect(state.context).toMatchObject({ fabId, commandId, revision: 2, outcome: 'executing' });
      expect(state.state).toBe('executing');
    }
    registry.disposeAll();
    expect(registry.size).toBe(0);
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
