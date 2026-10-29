import { afterEach, expect, it } from 'vitest';
import {
  CountingCommandWorkflow,
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createTestFab,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

it('CORE-008 runs each command-scope finalizer exactly once across eviction and FAB dispose', async () => {
  const source = new FakeCommandEventSource();
  const workflows: CountingCommandWorkflow[] = [];
  const fab = createTestFab({
    source,
    createWorkflow: (fabId, commandId) => {
      const workflow = new CountingCommandWorkflow(fabId, commandId);
      workflows.push(workflow);
      return workflow;
    },
    retention: { maxTerminalWorkflows: 1, terminalTtlMs: 60_000, sweepIntervalMs: 1_000 },
  });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('active');
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'active', revision: 1, outcome: 'executing' }));
  for (const commandId of ['done-1', 'done-2', 'done-3']) {
    runtime.trackCommand(commandId);
    source.emit(commandResult({ fabId: 'fab-a', commandId, revision: 2, outcome: 'succeeded' }));
  }

  // Cap 1 terminal workflow: two terminal command scopes were evicted and closed.
  expect(runtime.workflowCount).toBe(2);
  expect(runtime.lifecycleCounts.created).toBe(4);
  expect(runtime.lifecycleCounts.finalized).toBe(2);
  const evicted = workflows.filter((workflow) => workflow.commandId === 'done-1' || workflow.commandId === 'done-2');
  expect(evicted.map((workflow) => workflow.disposeCalls)).toEqual([1, 1]);

  runtime.dispose();
  // Every actor/finalizer ran exactly once; closing the already-closed child
  // scopes during FabScope teardown cannot run a finalizer twice.
  for (const workflow of workflows) expect(workflow.disposeCalls, workflow.commandId).toBe(1);
  expect(runtime.lifecycleCounts.finalized).toBe(4);
  expect(runtime.workflowCount).toBe(0);
});

it('CORE-008 disposes actors after the terminal TTL while the projection stays readable', async () => {
  let now = 0;
  const source = new FakeCommandEventSource();
  const workflows: CountingCommandWorkflow[] = [];
  const fab = createTestFab({
    source,
    createWorkflow: (fabId, commandId) => {
      const workflow = new CountingCommandWorkflow(fabId, commandId);
      workflows.push(workflow);
      return workflow;
    },
    retention: { terminalTtlMs: 100, sweepIntervalMs: 5, now: () => now },
  });
  fabs.push(fab);
  const runtime = fab.runtime;
  runtime.start();
  runtime.trackCommand('cmd-1');
  source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
  expect(runtime.workflowCount).toBe(1);
  now = 1_000;
  await expect.poll(() => runtime.workflowCount, { timeout: 1_000 }).toBe(0);
  expect(workflows[0].disposeCalls).toBe(1);
  expect(runtime.getProjection('cmd-1')).toMatchObject({ outcome: 'succeeded' });
  expect(runtime.retainedProjectionCount).toBe(1);
  runtime.dispose();
  expect(workflows[0].disposeCalls).toBe(1);
  expect(runtime.getProjection('cmd-1')).toBeUndefined();
});
