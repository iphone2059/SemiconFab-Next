// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import { FakeCommandEventSource, commandResult } from '../support/command-fakes.ts';

const fabId = 'fab-a';
const trackedCommandId = 'cmd-1';
const unrelatedCommandId = 'cmd-2';

let renderCount = 0;

/**
 * B05: one ProjectionRow per command subscribes to the per-FAB runtime
 * broadcast. Only a value change of THIS command may rerender the row; a fresh
 * but value-equal projection object must be rejected.
 */
function RowProbe() {
  renderCount += 1;
  const projection = useCommandProjection(fabId, trackedCommandId);
  return <span data-testid="projection">{projection ? `${projection.state}:${projection.revision}:${projection.outcome}` : 'none'}</span>;
}

afterEach(() => {
  cleanup();
  renderCount = 0;
});

it('keeps a ProjectionRow unrendered when unrelated command results publish an equal projection', async () => {
  const source = new FakeCommandEventSource();
  const runtime = new FabRuntimeFactory({ sourceFor: () => source }).create(fabId);
  runtime.start();
  runtime.trackCommand(trackedCommandId);
  runtime.trackCommand(unrelatedCommandId);
  const registry = new FabRuntimeRegistry();
  registry.register(runtime);

  render(<RuntimeProvider registry={registry}><RowProbe /></RuntimeProvider>);
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));
  const settled = renderCount;

  // The per-FAB broadcast fires for every command result, but cmd-1's projection
  // is unchanged; the row must not rerender.
  act(() => {
    source.emit(commandResult({ fabId, commandId: unrelatedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));
  expect(renderCount, 'unrelated command result must not rerender the row').toBe(settled);

  // A result for the tracked command changes the value and must rerender.
  act(() => {
    source.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1:accepted'));
  expect(renderCount).toBeGreaterThan(settled);
  const afterValueChange = renderCount;

  // A duplicate/replayed revision is ignored by the workflow, so the projection
  // is value-equal again; no extra rerender.
  act(() => {
    source.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('accepted:1:accepted');
  expect(renderCount, 'value-equal re-publish must not rerender the row').toBe(afterValueChange);

  runtime.dispose();
});
