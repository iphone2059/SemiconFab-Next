// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { FabRuntime } from '@/runtime/fab-runtime';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createTestFab,
} from '../support/command-fakes.ts';

const fabId = 'fab-a';
const commandId = 'cmd-1';

const fabs: TestFab[] = [];
afterEach(async () => {
  cleanup();
  for (const fab of fabs.splice(0)) await fab.dispose();
});

function runtimeWithSource(source: FakeCommandEventSource): { runtime: FabRuntime; fab: TestFab } {
  const fab = createTestFab({ source });
  fabs.push(fab);
  fab.runtime.start();
  fab.runtime.trackCommand(commandId);
  return { runtime: fab.runtime, fab };
}

function Probe() {
  const projection = useCommandProjection(fabId, commandId);
  return <span data-testid="projection">{projection ? projection.state + ':' + projection.revision : 'none'}</span>;
}

it('re-subscribes to the replacement runtime instead of keeping a disposed one', async () => {
  const firstSource = new FakeCommandEventSource();
  const first = runtimeWithSource(firstSource);
  const firstRegistry = new FabRuntimeRegistry();
  firstRegistry.register(first.runtime);

  const { rerender } = render(
    <RegistryContext.Provider value={first.fab.harness.registry}>
      <RuntimeProvider registry={firstRegistry} version={0}><Probe /></RuntimeProvider>
    </RegistryContext.Provider>,
  );
  firstSource.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));

  firstRegistry.disposeAll();
  expect(firstSource.commandObservers).toBe(0);
  const secondSource = new FakeCommandEventSource();
  const second = runtimeWithSource(secondSource);
  const secondRegistry = new FabRuntimeRegistry();
  secondRegistry.register(second.runtime);

  rerender(
    <RegistryContext.Provider value={second.fab.harness.registry}>
      <RuntimeProvider registry={secondRegistry} version={1}><Probe /></RuntimeProvider>
    </RegistryContext.Provider>,
  );
  // The context version + different Atom identity make the hook read the new runtime.
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1'));
  secondSource.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));

  // A late event from the old source/runtime must not update the replacement projection.
  firstSource.emit(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('accepted:1');
  secondRegistry.disposeAll();
  expect(secondSource.commandObservers).toBe(0);
});
