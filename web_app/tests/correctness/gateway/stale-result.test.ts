/**
 * F4 / matrix-4 — stale authoritative results never write the actor (ADR-011 §2.2).
 *
 * Two layers guard the write: the scheduler entry generation (entryId + in-flight
 * identity) and the FabRuntime workflow identity (target.isCurrent). A result that
 * resolves after the entry was superseded/timed out is dropped before receive().
 */
import { Effect } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import { CommandReconciler } from '@/runtime/command-reconciler';
import type { FabReconciliationScheduler } from '@/runtime/fab-reconciliation-scheduler';
import { afterEach, expect, it } from 'vitest';
import {
  createGatewayTestRuntime,
  createSchedulerHarness,
  effectGateway,
  RecordingWorkflow,
  resultEvent,
  sleep,
  waitFor,
  type GatewayTestRuntime,
} from './harness.ts';

const runtimes: GatewayTestRuntime[] = [];
const schedulers: FabReconciliationScheduler[] = [];

function trackRuntime(): GatewayTestRuntime {
  const rt = createGatewayTestRuntime();
  runtimes.push(rt);
  return rt;
}

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.dispose();
  for (const rt of runtimes.splice(0)) await rt.dispose();
});

it('CommandReconciler validates the scheduler entry generation before applying the result', async () => {
  let release!: (value: CommandResultEvent | null) => void;
  const gateway: CommandGateway = {
    getCommandStatus: () => Effect.tryPromise({
      try: () => new Promise<CommandResultEvent | null>((resolve) => { release = resolve; }),
      catch: (cause: unknown): CommandGatewayError => ({ _tag: 'CommandGatewayRetryableFailure', message: 'failed', cause }),
    }),
    listFabCommands: () => Effect.succeed({ epoch: 'epoch-1', latestSequence: 0, commands: [] }),
    getCommandJournalPage: (_siteId, _fabId, query) => Effect.succeed({
      epoch: query.epoch, hasGap: false, firstRetainedSequence: 0, latestSequence: query.afterSequence, events: [], nextAfterSequence: query.afterSequence,
    }),
  };
  const reconciler = new CommandReconciler(gateway);
  const workflow = new RecordingWorkflow();
  let current = true;
  let observedEntryId = -1;
  const pending = Effect.runPromise(reconciler.reconcile(workflow, 'fab-a', 'cmd-1', {
    entryId: 7,
    apply: (event) => { workflow.receiveAuthoritative(event); return true; },
    isCurrent: (identity) => {
      observedEntryId = identity.entryId;
      return current;
    },
  }));
  await sleep(5);
  // The entry was superseded while the authoritative request was still in flight.
  current = false;
  release(resultEvent({ revision: 3, outcome: 'succeeded' }));
  await expect(pending).resolves.toBe(false);
  expect(observedEntryId).toBe(7);
  expect(workflow.received).toEqual([]);
});

it('CommandReconciler applies the result while the workflow and generation are current', async () => {
  const reconciler = new CommandReconciler(effectGateway((fabId, commandId) =>
    Promise.resolve({ fabId, commandId, revision: 4, outcome: 'succeeded', occurredAt: '2026-10-30T00:00:00.000Z' })));
  const workflow = new RecordingWorkflow();
  const delivered = await Effect.runPromise(reconciler.reconcile(workflow, 'fab-a', 'cmd-1', {
    entryId: 1,
    apply: (event) => { workflow.receiveAuthoritative(event); return true; },
    isCurrent: () => true,
  }));
  expect(delivered).toBe(true);
  expect(workflow.received).toHaveLength(1);
});

it('scheduler drops a result when the workflow target turned stale before it resolved', async () => {
  const rt = trackRuntime();
  let current = true;
  const gateway = effectGateway((_fabId, commandId) => new Promise<CommandResultEvent | null>((resolve) => {
    setTimeout(() => resolve(resultEvent({ commandId, revision: 2, outcome: 'succeeded' })), 30);
  }));
  const harness = createSchedulerHarness(rt, { gateway, timeoutMs: 500, isCurrent: () => current });
  schedulers.push(harness.scheduler);
  const workflow = harness.workflowFor('cmd-1');
  const reconciled = harness.scheduler.schedule('cmd-1');
  await sleep(5);
  current = false;
  // The late result is dropped by the stale generation guard: an explicit converged
  // result, never a silent boolean.
  await expect(reconciled).resolves.toEqual({ commandId: 'cmd-1', status: 'not-found' });
  expect(workflow.received).toEqual([]);
  expect(harness.scheduler.stats.failed).toBe(1);
});

it('a timed-out entry is settled before its late result resolves (no second write window)', async () => {
  const rt = trackRuntime();
  let releaseLate!: (value: CommandResultEvent | null) => void;
  const gateway = effectGateway(() => new Promise<CommandResultEvent | null>((resolve) => { releaseLate = resolve; }));
  const harness = createSchedulerHarness(rt, { gateway, timeoutMs: 20 });
  schedulers.push(harness.scheduler);
  const workflow = harness.workflowFor('cmd-1');
  const reconciled = harness.scheduler.schedule('cmd-1');
  await waitFor(() => harness.scheduler.stats.timedOut === 1 && harness.scheduler.stats.inFlight === 0);
  releaseLate(resultEvent({ revision: 9 }));
  await sleep(30);
  await expect(reconciled).resolves.toMatchObject({ commandId: 'cmd-1', status: 'timed-out' });
  expect(workflow.received).toEqual([]);
});
