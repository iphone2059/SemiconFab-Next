import { expect, it } from 'vitest';
import {
  FakeCommandEventSource,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
} from '../support/command-fakes.ts';

it('CORE-009 rebuilds the same FAB on the same registry without old projections or events', async () => {
  const harness = createCommandTestRuntime();
  try {
    const firstSource = new FakeCommandEventSource();
    const first = createFabRuntime(harness, { source: firstSource });
    first.start();
    first.trackCommand('cmd-1');
    firstSource.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'accepted' }));
    expect(first.getProjection('cmd-1')).toMatchObject({ state: 'accepted', revision: 1 });

    const oldAtom = first.projectionAtom('cmd-1');
    expect(harness.registry.get(oldAtom)).toMatchObject({ state: 'accepted' });

    first.dispose();
    // The old Atom is invalidated inside the same registry: no stale read path.
    expect(harness.registry.get(oldAtom)).toBeUndefined();
    expect(firstSource.commandObservers).toBe(0);

    const secondSource = new FakeCommandEventSource();
    const second = createFabRuntime(harness, { source: secondSource });
    second.start();
    expect(second.getProjection('cmd-1')).toBeUndefined();
    second.trackCommand('cmd-1');
    expect(second.getProjection('cmd-1')).toMatchObject({ state: 'idle', revision: -1, outcome: 'pending' });

    // A late event from the disposed generation must not reach the replacement.
    firstSource.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'executing' }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(second.getProjection('cmd-1')).toMatchObject({ state: 'idle', revision: -1 });

    secondSource.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'accepted' }));
    expect(second.getProjection('cmd-1')).toMatchObject({ state: 'accepted', revision: 1 });
    second.dispose();
  } finally {
    await harness.dispose();
  }
});
