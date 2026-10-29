// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import { commandProjectionAtom, commandProjectionKey } from '@/runtime/command-projection.atom';
import { EffectCommandWorkflowScope } from '@/runtime/command-workflow-scope';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes.ts';

const idleProjection = { state: 'idle', revision: -1, outcome: 'pending' as const };

it('owns actor acquisition/disposal through one Effect Scope, exactly once', () => {
  const disposals: string[] = [];
  const scope = new EffectCommandWorkflowScope();
  const acquire = (_fabId: string, commandId: string): CommandWorkflow => ({
    receive() {}, async reconcile() {}, dispose() { disposals.push(commandId); },
    projection: { state: 'idle', revision: -1, outcome: 'pending' },
  });
  scope.acquire(acquire, 'fab-a', 'cmd-1');
  scope.acquire(acquire, 'fab-a', 'cmd-2');
  expect(disposals).toEqual([]);
  scope.close();
  // Effect Scope finalizers run LIFO; ownership, not order, is the contract.
  expect([...disposals].sort()).toEqual(['cmd-1', 'cmd-2']);
  const afterClose = [...disposals];
  scope.close();
  expect([...disposals].sort()).toEqual([...afterClose].sort());
  expect(() => scope.acquire(acquire, 'fab-a', 'cmd-3')).toThrow();
});

it('publishes the first projection snapshot and every delivered revision to the read-only atom', () => {
  const registry = AtomRegistry.make({ defaultIdleTTL: 300_000 });
  const source = new FakeCommandEventSource();
  const runtime = new FabRuntimeFactory({ sourceFor: () => source, projectionRegistry: registry }).create('fab-a');
  const atom = commandProjectionAtom(commandProjectionKey('fab-a', 'cmd-1'));
  runtime.start();
  runtime.trackCommand('cmd-1');
  expect(registry.get(atom), 'the initial actor snapshot must not be lost').toMatchObject(idleProjection);

  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  expect(registry.get(atom)).toMatchObject({ state: 'executing', revision: 1, outcome: 'executing' });

  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
  expect(registry.get(atom)).toMatchObject({ state: 'succeeded', revision: 2, outcome: 'succeeded' });
  runtime.dispose();
});

it('renders through the Atom projection via useCommandProjection', () => {
  const registry = AtomRegistry.make({ defaultIdleTTL: 300_000 });
  const source = new FakeCommandEventSource();
  const runtime = new FabRuntimeFactory({ sourceFor: () => source, projectionRegistry: registry }).create('fab-a');
  runtime.start();
  runtime.trackCommand('cmd-1');
  const runtimes = new FabRuntimeRegistry();
  runtimes.register(runtime);
  const { result } = renderHook(
    () => useCommandProjection('fab-a', 'cmd-1'),
    { wrapper: ({ children }) => (
      <RegistryContext.Provider value={registry}>
        <RuntimeProvider registry={runtimes}>{children}</RuntimeProvider>
      </RegistryContext.Provider>
    ) },
  );
  expect(result.current?.state).toBe('idle');
  act(() => {
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  });
  expect(result.current).toMatchObject({ state: 'executing', revision: 1 });
  runtime.dispose();
});
