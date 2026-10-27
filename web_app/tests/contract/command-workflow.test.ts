import { expect, it } from 'vitest';
import type { CommandGateway } from '../../src/application/contracts/CommandGateway';
import { CommandReconciler } from '../../src/runtime/commands/CommandReconciler';
import { XStateCommandWorkflowAdapter } from '../../src/runtime/commands/XStateCommandWorkflowAdapter';
import { commandResult } from '../support/command-fakes';

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

it('uses the authoritative reconciler to converge a workflow after a disconnect', async () => {
  const gateway: CommandGateway = {
    getCommandStatus: async () => commandResult({ fabId, commandId, revision: 5, outcome: 'succeeded' }),
  };
  const reconciler = new CommandReconciler(gateway);
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId, reconciler);
  workflow.receive(commandResult({ fabId, commandId, revision: 1, outcome: 'accepted' }));
  await workflow.reconcile(commandId);
  expect(workflow.state).toBe('succeeded');
  workflow.dispose();
});
