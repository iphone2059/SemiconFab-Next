import { describe, expect, it } from 'vitest';
import type { CommandGateway } from '../../src/application/contracts/CommandGateway';
import { XStateCommandWorkflowAdapter } from '../../src/workflows/equipment/XStateCommandWorkflowAdapter';
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
