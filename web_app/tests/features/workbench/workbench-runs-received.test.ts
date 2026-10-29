import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterAll, expect, it } from 'vitest';
import { initialWorkbenchState, workbenchActions, workbenchAtom } from '@/workbench/workbench.atom';

/**
 * Regression for the CORE-011 compiler-OFF defect: workbench.tsx dispatched the
 * runs projection from an effect whose dependency was a freshly filtered array.
 * The Oxc compiler ON build memoized that array and hid the bug; OFF entered
 * React #185 (Maximum update depth exceeded) because runsReceived produced a new
 * state object for an unchanged run id. Both the reducer (idempotent) and the
 * effect dependency (stable run-id key) must keep this from re-notifying.
 */
const registry = AtomRegistry.make();
afterAll(() => registry.dispose());

it('runsReceived does not notify on an unchanged projection', () => {
  registry.set(workbenchAtom, { ...initialWorkbenchState, siteId: 'site-1', runId: '' });
  let notifications = 0;
  const unsubscribe = registry.subscribe(workbenchAtom, () => { notifications += 1; });
  try {
    // Empty first page: runId stays '' -> no state change, no notification.
    workbenchActions.runsReceived(registry, { siteId: 'site-1', runIds: [] });
    expect(notifications).toBe(0);
    expect(registry.get(workbenchAtom).runId).toBe('');
    // First actual run id: exactly one notification.
    workbenchActions.runsReceived(registry, { siteId: 'site-1', runIds: ['run-a'] });
    expect(notifications).toBe(1);
    expect(registry.get(workbenchAtom).runId).toBe('run-a');
    // Repeating the same projection must be a no-op (would otherwise loop renders).
    workbenchActions.runsReceived(registry, { siteId: 'site-1', runIds: ['run-a'] });
    expect(notifications).toBe(1);
    // A foreign site projection must not mutate the local selection.
    registry.set(workbenchAtom, { ...registry.get(workbenchAtom), runId: '' });
    workbenchActions.runsReceived(registry, { siteId: 'site-2', runIds: ['run-b'] });
    expect(registry.get(workbenchAtom).runId).toBe('');
  } finally {
    unsubscribe();
  }
});
