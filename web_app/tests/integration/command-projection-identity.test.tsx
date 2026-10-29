// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createTestFab,
} from '../support/command-fakes.ts';

const fabId = 'fab-a';
const trackedCommandId = 'cmd-1';
const unrelatedCommandId = 'cmd-2';

let renderCount = 0;

/**
 * B05: one ProjectionRow per command reads exactly one Atom. Only a value change
 * of THIS command may rerender the row; a fresh but value-equal projection must
 * be rejected by the projection store before it reaches the registry.
 */
function RowProbe() {
  renderCount += 1;
  const projection = useCommandProjection(fabId, trackedCommandId);
  return <span data-testid="projection">{projection ? projection.state + ':' + projection.revision + ':' + projection.outcome : 'none'}</span>;
}

const fabs: TestFab[] = [];
afterEach(async () => {
  cleanup();
  renderCount = 0;
  for (const fab of fabs.splice(0)) await fab.dispose();
});

it('keeps a ProjectionRow unrendered when unrelated or value-equal projections are published', async () => {
  const source = new FakeCommandEventSource();
  const fab = createTestFab({ source });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand(trackedCommandId);
  runtime.trackCommand(unrelatedCommandId);
  const registry = new FabRuntimeRegistry();
  registry.register(runtime);

  render(
    <RegistryContext.Provider value={fab.harness.registry}>
      <RuntimeProvider registry={registry}><RowProbe /></RuntimeProvider>
    </RegistryContext.Provider>,
  );
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));
  const settled = renderCount;

  act(() => {
    source.emit(commandResult({ fabId, commandId: unrelatedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));
  expect(renderCount, 'unrelated command result must not rerender the row').toBe(settled);

  act(() => {
    source.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1:accepted'));
  expect(renderCount).toBeGreaterThan(settled);
  const afterValueChange = renderCount;

  // A duplicate/replayed revision leaves the projection value-equal; the store
  // rejects it before the Atom write, so no extra rerender happens.
  act(() => {
    source.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('accepted:1:accepted');
  expect(renderCount, 'value-equal re-publish must not rerender the row').toBe(afterValueChange);
});
