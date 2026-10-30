import { expect, it } from 'vitest';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { commandResult } from '../support/command-fakes.ts';

const fabId = 'fab-a';
const commandId = 'cmd-1';

it('drives the XState v6 command machine through accepted/executing/succeeded', () => {
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
  expect(workflow.state).toBe('idle');
  workflow.receive(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  expect(workflow.state).toBe('accepted');
  workflow.receive(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
  expect(workflow.state).toBe('executing');
  workflow.receive(commandResult({ fabId, commandId, revision: 3, outcome: 'succeeded' }));
  expect(workflow.state).toBe('succeeded');
  expect(workflow.isTerminal).toBe(true);
  expect(workflow.context).toMatchObject({ fabId, commandId, revision: 3, outcome: 'succeeded' });
  workflow.dispose();
});

it('ignores duplicate, stale and post-terminal revisions before reaching the actor', () => {
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
  workflow.receive(commandResult({ fabId, commandId, revision: 2, outcome: 'executing' }));
  workflow.receive(commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }));
  expect(workflow.state).toBe('executing');
  workflow.receive(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  expect(workflow.state).toBe('executing');
  workflow.receive(commandResult({ fabId, commandId, revision: 3, outcome: 'failed' }));
  expect(workflow.state).toBe('failed');
  workflow.receive(commandResult({ fabId, commandId, revision: 4, outcome: 'succeeded' }));
  expect(workflow.state).toBe('failed');
  workflow.dispose();
});

it('does not reconcile through the workflow adapter: the scheduler is the only authority (ADR-011 §2.2)', async () => {
  // Direct per-workflow reconciliation would bypass the FAB physical budget,
  // timeout and stale-result guard, so the adapter owns no network authority.
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
  workflow.receive(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  await workflow.reconcile(commandId);
  expect(workflow.state, 'adapter.reconcile is a no-op; only the scheduler converges').toBe('accepted');
  expect(workflow.context.revision).toBe(1);
  workflow.dispose();
});


it('keeps a pruned result unresolved until a later real terminal event arrives', () => {
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
  workflow.receive(commandResult({ fabId, commandId, revision: 1, outcome: 'executing' }));
  workflow.markExpiredUnresolved();
  expect(workflow.projection).toMatchObject({ state: 'expired', revision: 1, outcome: 'executing', recoveryDisposition: 'expired-unresolved' });
  workflow.receive(commandResult({ fabId, commandId, revision: 2, outcome: 'succeeded' }));
  expect(workflow.projection).toMatchObject({ state: 'succeeded', revision: 2, outcome: 'succeeded', recoveryDisposition: 'tracked' });
  workflow.dispose();
});
