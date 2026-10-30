// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RuntimeProvider, useCommandProjection } from '@/app/runtime-provider';
import type { FabIdentity } from '@/domain/fab-identity';
import { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
  createTestFab,
} from '../support/command-fakes.ts';

const fabId = 'fab-01';
const siteA = 'site-a';
const siteB = 'site-b';
const siteAFab = { siteId: siteA, fabId } as const;
const siteBFab = { siteId: siteB, fabId } as const;
const trackedCommandId = 'cmd-1';
const unrelatedCommandId = 'cmd-2';

let renderCount = 0;

/**
 * B05: one ProjectionRow per command reads exactly one Atom. Only a value change
 * of THIS command may rerender the row; a fresh but value-equal projection must
 * be rejected by the projection store before it reaches the registry.
 *
 * R5.4-03: the row addresses the FAB by its complete (siteId, fabId) identity, so
 * the same commandId in two sites can never share a runtime or an Atom (T08).
 */
function RowProbe({ identity: target, commandId, testId }: { identity: FabIdentity; commandId: string; testId: string }) {
  renderCount += 1;
  const projection = useCommandProjection(target, commandId);
  return <span data-testid={testId}>{projection ? projection.state + ':' + projection.revision + ':' + projection.outcome : 'none'}</span>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  cleanup();
  renderCount = 0;
  for (const cleanupEntry of cleanups.splice(0)) await cleanupEntry();
});

it('keeps a ProjectionRow unrendered when unrelated or value-equal projections are published', async () => {
  const source = new FakeCommandEventSource();
  const fab: TestFab = createTestFab({ siteId: siteA, fabId, source });
  cleanups.push(() => fab.dispose());
  const runtime = fab.runtime;
  runtime.start();
  runtime.registerAcceptedCommand(trackedCommandId);
  runtime.registerAcceptedCommand(unrelatedCommandId);
  const registry = new FabRuntimeRegistry();
  registry.register(runtime);

  render(
    <RegistryContext.Provider value={fab.harness.registry}>
      <RuntimeProvider registry={registry}><RowProbe identity={siteAFab} commandId={trackedCommandId} testId="projection" /></RuntimeProvider>
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

it('R5.4-03 T08: the same commandId in two sites does not share a Projection Atom or runtime', async () => {
  const harness = createCommandTestRuntime();
  const sourceA = new FakeCommandEventSource();
  const sourceB = new FakeCommandEventSource();
  const runtimeA = createFabRuntime(harness, { siteId: siteA, fabId, source: sourceA });
  const runtimeB = createFabRuntime(harness, { siteId: siteB, fabId, source: sourceB });
  cleanups.push(() => { runtimeA.dispose(); runtimeB.dispose(); return harness.dispose(); });
  runtimeA.start();
  runtimeB.start();
  runtimeA.registerAcceptedCommand(trackedCommandId);
  runtimeB.registerAcceptedCommand(trackedCommandId);

  const registry = new FabRuntimeRegistry();
  registry.register(runtimeA);
  registry.register(runtimeB);
  expect(registry.get(siteAFab)).toBe(runtimeA);
  expect(registry.get(siteBFab)).toBe(runtimeB);

  render(
    <RegistryContext.Provider value={harness.registry}>
      <RuntimeProvider registry={registry} version={0}>
        <RowProbe identity={siteAFab} commandId={trackedCommandId} testId="projection-a" />
        <RowProbe identity={siteBFab} commandId={trackedCommandId} testId="projection-b" />
      </RuntimeProvider>
    </RegistryContext.Provider>,
  );
  await waitFor(() => expect(screen.getByTestId('projection-a').textContent).toBe('idle:-1:pending'));
  expect(screen.getByTestId('projection-b').textContent).toBe('idle:-1:pending');
  // Distinct runtimes => distinct Atom identities for the same (commandId).
  expect(runtimeA.projectionAtom(trackedCommandId)).not.toBe(runtimeB.projectionAtom(trackedCommandId));

  // A Site A result advances only the Site A row.
  act(() => {
    sourceA.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection-a').textContent).toBe('accepted:1:accepted'));
  expect(screen.getByTestId('projection-b').textContent).toBe('idle:-1:pending');

  // A Site B result advances only the Site B row (same wire fabId on both streams).
  act(() => {
    sourceB.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 2, outcome: 'failed' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection-b').textContent).toBe('failed:2:failed'));
  expect(screen.getByTestId('projection-a').textContent).toBe('accepted:1:accepted');
});

it('R5.4-03 T11: a late event from the old site generation cannot modify the replacement Projection Atom', async () => {
  const harness = createCommandTestRuntime();
  const oldSource = new FakeCommandEventSource();
  const oldRuntime = createFabRuntime(harness, { siteId: siteA, fabId, source: oldSource });
  oldRuntime.start();
  oldRuntime.registerAcceptedCommand(trackedCommandId);
  const registry = new FabRuntimeRegistry();
  registry.register(oldRuntime);
  cleanups.push(() => { oldRuntime.dispose(); newRuntime.dispose(); return harness.dispose(); });
  let newRuntime = oldRuntime;

  const tree = (version: number) => (
    <RegistryContext.Provider value={harness.registry}>
      <RuntimeProvider registry={registry} version={version}>
        <RowProbe identity={siteAFab} commandId={trackedCommandId} testId="projection" />
      </RuntimeProvider>
    </RegistryContext.Provider>
  );
  const view = render(tree(0));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));

  // Replace the whole site generation for the same identity (sites reload).
  act(() => { registry.disposeAll(); });
  const newSource = new FakeCommandEventSource();
  newRuntime = createFabRuntime(harness, { siteId: siteA, fabId, source: newSource });
  newRuntime.start();
  newRuntime.registerAcceptedCommand(trackedCommandId);
  act(() => { registry.register(newRuntime); });
  expect(registry.get(siteAFab)).toBe(newRuntime);
  view.rerender(tree(1));
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending'));
  expect(oldRuntime.projectionAtom(trackedCommandId)).not.toBe(newRuntime.projectionAtom(trackedCommandId));

  // A frame already queued by the disposed old generation (same fabId on the wire)
  // must never reach the replacement runtime's Atom.
  act(() => {
    oldSource.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 7, outcome: 'succeeded' }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByTestId('projection').textContent).toBe('idle:-1:pending');

  // The current generation still applies its own result.
  act(() => {
    newSource.emit(commandResult({ fabId, commandId: trackedCommandId, revision: 1, outcome: 'accepted' }));
  });
  await waitFor(() => expect(screen.getByTestId('projection').textContent).toBe('accepted:1:accepted'));
  view.unmount();
});
