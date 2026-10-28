// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '../../src/app/providers/RuntimeProvider';
import { FabRuntimeFactory } from '../../src/runtime/FabRuntimeFactory';
import { FabRuntimeRegistry } from '../../src/runtime/FabRuntimeRegistry';
import type { FabRuntime } from '../../src/runtime/FabRuntime';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes';

const fabId = 'fab-a';
const commandId = 'cmd-1';

function runtimeWithSource(source: FakeCommandEventSource): FabRuntime {
  const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create(fabId);
  runtime.start();
  runtime.trackCommand(commandId);
  return runtime;
}

function Probe() {
  const projection = useCommandProjection(fabId, commandId);
  return <span data-testid="projection">{projection ? `${projection.state}:${projection.revision}` : 'none'}</span>;
}

afterEach(cleanup);

it('re-subscribes to the replacement runtime instead of keeping a disposed one', async () => {
  const firstSource = new FakeCommandEventSource();
  const firstRuntime = runtimeWithSource(firstSource);
  const firstRegistry = new FabRuntimeRegistry();
  firstRegistry.register(firstRuntime);

  const { rerender } = render(
    <RuntimeProvider registry={firstRegistry} version={0}><Probe /></RuntimeProvider>,
  );
  firstSource.emit(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1'));

  firstRegistry.disposeAll();
  expect(firstSource.commandObservers).toBe(0);
  const secondSource = new FakeCommandEventSource();
  const secondRuntime = runtimeWithSource(secondSource);
  const secondRegistry = new FabRuntimeRegistry();
  secondRegistry.register(secondRuntime);

  rerender(<RuntimeProvider registry={secondRegistry} version={1}><Probe /></RuntimeProvider>);
  // The context version bump makes the hook pick the new runtime; no stale first projection.
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
