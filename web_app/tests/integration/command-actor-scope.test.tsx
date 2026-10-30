// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createTestFab,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

const idleProjection = { state: 'idle', revision: -1, outcome: 'pending' as const };

it('publishes the first projection snapshot and every delivered revision to the read-only atom', () => {
  const source = new FakeCommandEventSource();
  const fab = createTestFab({ source });
  fabs.push(fab);
  const runtime = fab.runtime;
  const atom = runtime.projectionAtom('cmd-1');
  runtime.start();
  runtime.registerAcceptedCommand('cmd-1');
  expect(fab.harness.registry.get(atom), 'the initial actor snapshot must not be lost').toMatchObject(idleProjection);

  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  expect(fab.harness.registry.get(atom)).toMatchObject({ state: 'executing', revision: 1, outcome: 'executing' });

  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
  expect(fab.harness.registry.get(atom)).toMatchObject({ state: 'succeeded', revision: 2, outcome: 'succeeded' });
  runtime.dispose();
});

it('owns one CommandScope per command and no global workflow scope or subscribe fallback', () => {
  const disposals: string[] = [];
  const fab = createTestFab({
    source: new FakeCommandEventSource(),
    createWorkflow: (_fabId, commandId): CommandWorkflow => ({
      receive() {},
      markExpiredUnresolved() {},
      async reconcile() {},
      dispose() {
        disposals.push(commandId);
      },
      projection: { state: 'idle', revision: -1, outcome: 'pending', recoveryDisposition: 'tracked' },
    }),
    retention: { maxResolvedWorkflows: 1, resolvedWorkflowTtlMs: 60_000, sweepIntervalMs: 1_000 },
  });
  fabs.push(fab);
  const runtime = fab.runtime;
  // The single-projection contract has no runtime broadcast fallback (INV-11).
  expect('subscribe' in runtime).toBe(false);
  runtime.start();
  const source = fab.runtime === runtime ? undefined : undefined;
  void source;
  runtime.registerAcceptedCommand('cmd-1');
  runtime.registerAcceptedCommand('cmd-2');
  expect(runtime.workflowCount).toBe(2);
  runtime.dispose();
  // One finalizer per command Scope, exactly once.
  expect([...disposals].sort()).toEqual(['cmd-1', 'cmd-2']);
  runtime.dispose();
  expect([...disposals].sort()).toEqual(['cmd-1', 'cmd-2']);
});

it('renders through the Atom projection via useCommandProjection', () => {
  const source = new FakeCommandEventSource();
  const fab = createTestFab({ source });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.registerAcceptedCommand('cmd-1');
  const runtimes = new FabRuntimeRegistry();
  runtimes.register(runtime);
  const { result, rerender } = renderHook(
    () => useCommandProjection('fab-a', 'cmd-1'),
    {
      wrapper: ({ children }) => (
        <RegistryContext.Provider value={fab.harness.registry}>
          <RuntimeProvider registry={runtimes}>{children}</RuntimeProvider>
        </RegistryContext.Provider>
      ),
    },
  );
  expect(result.current?.state).toBe('idle');
  act(() => {
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' }));
  });
  rerender();
  expect(result.current).toMatchObject({ state: 'executing', revision: 1 });
  runtime.dispose();
});
