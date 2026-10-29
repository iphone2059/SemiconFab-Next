import { afterEach, describe, expect, it } from 'vitest';
import type { FabRuntime } from '@/runtime/fab-runtime';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { FabLifecycleCoordinator } from '@/runtime/fab-lifecycle-coordinator';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import {
  FakeCommandEventSource,
  type TestFab,
  type TestFabOptions,
  commandResult,
  createTestFab,
  fakeCommandGateway,
} from '../support/command-fakes.ts';

const commandId = 'cmd-1';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function createFab(options: TestFabOptions = {}): TestFab {
  const fab = createTestFab(options);
  fabs.push(fab);
  return fab;
}

function adapter(runtime: FabRuntime): XStateCommandWorkflowAdapter {
  const workflow = runtime.getWorkflow(commandId);
  if (!(workflow instanceof XStateCommandWorkflowAdapter)) throw new Error('expected XState adapter');
  return workflow;
}

describe('FabRuntime single-FAB assembly (CE-07)', () => {
  it('replaces the FAB runtime without carrying its old workflow or source into the new generation', async () => {
    const oldSource = new FakeCommandEventSource();
    const newSource = new FakeCommandEventSource();
    const registry = new FabRuntimeRegistry();
    const first = createFab({ source: oldSource });
    registry.register(first.runtime);
    expect(registry.size).toBe(1);
    expect(registry.fabIds).toEqual(['fab-a']);
    registry.startAll();
    const oldWorkflow = first.runtime.trackCommand(commandId);
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 5, outcome: 'executing' }));
    expect(adapter(first.runtime).state).toBe('executing');

    expect(registry.remove('fab-a')).toBe(first.runtime);
    expect(oldSource.commandObservers).toBe(0);
    const current = createFab({ source: newSource });
    registry.register(current.runtime);
    registry.startAll();
    expect(current.runtime.trackCommand(commandId)).not.toBe(oldWorkflow);
    expect(current.runtime.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    oldSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 6, outcome: 'succeeded' }));
    newSource.emit(commandResult({ fabId: 'unknown-fab', commandId, revision: 9, outcome: 'succeeded' }));
    expect(current.runtime.getProjection(commandId)).toMatchObject({ state: 'idle', revision: -1 });
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    newSource.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(current.runtime).context).toMatchObject({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' });
    expect(adapter(current.runtime).state).toBe('executing');
    expect(registry.size).toBe(1);
    registry.disposeAll();
    expect(registry.size).toBe(0);
    expect(newSource.commandObservers).toBe(0);
    await Promise.all([first.dispose(), current.dispose()]);
  });
});

describe('FabRuntime reconciliation and lifecycle (CE-06/CE-08)', () => {
  it('recovers a terminal result evicted before HTTP submission registers its workflow', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: 2, outcome: 'succeeded' }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    for (let index = 0; index < 256; index++) {
      source.emit(commandResult({ fabId: 'fab-a', commandId: 'other-' + index, revision: 2, outcome: 'succeeded' }));
    }
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('automatically reconciles active commands when the source reconnects', async () => {
    const source = new FakeCommandEventSource();
    let outcome: 'accepted' | 'succeeded' = 'accepted';
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) =>
        commandResult({ fabId, commandId: targetCommandId, revision: outcome === 'accepted' ? 0 : 2, outcome }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    await runtime.reconcileCommand(commandId);
    outcome = 'succeeded';
    source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('coalesces authoritative queries and ignores their results after disposal', async () => {
    const source = new FakeCommandEventSource();
    let complete!: (event: ReturnType<typeof commandResult>) => void;
    let queries = 0;
    const gateway = fakeCommandGateway({
      getCommandStatus: () => {
        queries++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    const pending = runtime.reconcileCommand(commandId);
    const concurrent = runtime.reconcileCommand(commandId);
    // The scheduler runs items on a scoped fiber; the duplicate calls merged into
    // one single-flight query.
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const gateway = fakeCommandGateway({
      getCommandStatus: async (fabId, targetCommandId) => {
        if (!available) throw new Error('offline');
        return commandResult({ fabId, commandId: targetCommandId, revision: 2, outcome: 'succeeded' });
      },
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
    available = true;
    source.reconnect();
    await expect.poll(() => runtime.getProjection(commandId)?.outcome, { timeout: 500 }).toBe('succeeded');
  });

  it('converges through the authoritative gateway after the stream stops (CE-06)', async () => {
    const source = new FakeCommandEventSource();
    const gateway = fakeCommandGateway({
      getCommandStatus: async () => commandResult({ fabId: 'fab-a', commandId, revision: 3, outcome: 'succeeded' }),
    });
    const { runtime } = createFab({ source, gateway });
    runtime.start();
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    runtime.stop();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'executing' }));
    expect(adapter(runtime).state).toBe('accepted');
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(true);
    expect(adapter(runtime).state).toBe('succeeded');
  });

  it('replays results that arrive before trackCommand created the workflow (CE-04 runtime path)', () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.start();
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'succeeded' }));
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.trackCommand(commandId)).toBeInstanceOf(XStateCommandWorkflowAdapter);
    expect(adapter(runtime).state).toBe('succeeded');
    expect(runtime.pendingCount).toBe(0);
  });

  it('stops delivery and disposes workflows/runtimes on lifecycle shutdown (CE-08)', async () => {
    const source = new FakeCommandEventSource();
    const created = createFab({ source });
    const registry = new FabRuntimeRegistry();
    registry.register(created.runtime);
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

  it('exposes read-only workflow projections through the bounded atom store', async () => {
    const source = new FakeCommandEventSource();
    const created = createFab({ source });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand(commandId);
    const atom = runtime.projectionAtom(commandId);
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'idle', revision: -1, outcome: 'pending' });
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 1, outcome: 'accepted' }));
    expect(created.harness.registry.get(atom)).toMatchObject({ state: 'accepted', revision: 1, outcome: 'accepted' });
    expect(runtime.getProjection(commandId)).toMatchObject({ state: 'accepted', revision: 1 });
  });

  it('exposes reconcileCommand only when a gateway is assembled', async () => {
    const source = new FakeCommandEventSource();
    const { runtime } = createFab({ source });
    runtime.trackCommand(commandId);
    await expect(runtime.reconcileCommand(commandId)).resolves.toBe(false);
  });
});
