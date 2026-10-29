/**
 * F4 / matrix-4 — real cancellation (ADR-011 §2.2, CR-04).
 *
 * These are the GREEN replacement of red-baseline.test.ts: the scheduler wraps the
 * REAL reconciler Effect (not a Promise) in Effect.timeoutOption, so a timeout
 * interrupts the fiber, aborts the fetch AbortSignal, ends the physical request and
 * releases the shared physical permit. A late result resolving after the timeout can
 * no longer write the actor.
 */
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type { FabReconciliationScheduler } from '@/runtime/fab-reconciliation-scheduler';
import { afterEach, expect, it } from 'vitest';
import {
  createGatewayTestRuntime,
  createSchedulerHarness,
  effectGateway,
  hungFetch,
  physicalCounters,
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

it('timeout aborts the physical fetch, clears physical pending and releases the shared permit', async () => {
  const rt = trackRuntime();
  const counters = physicalCounters();
  let releaseNever!: () => void;
  const hung = hungFetch(counters);
  const gateway = effectGateway((fabId, commandId, signal) => {
    if (commandId === 'cmd-hung') {
      releaseNever = () => undefined;
      return hung(fabId, commandId, signal);
    }
    return Promise.resolve(resultEvent({ commandId, revision: 1 }));
  });
  const harness = createSchedulerHarness(rt, { gateway, timeoutMs: 25 });
  schedulers.push(harness.scheduler);
  const workflow = harness.workflowFor('cmd-hung');

  const reconciles = harness.scheduler.schedule('cmd-hung');
  await waitFor(() => harness.scheduler.stats.timedOut === 1 && harness.scheduler.stats.inFlight === 0);

  console.error('[F4 counters] timeout -> signalAborts=%d physicalPending=%d budgetInFlight=%d timedOut=%d',
    counters.aborts, counters.pending, harness.budget.inFlight, harness.scheduler.stats.timedOut);
  expect(counters.started).toBe(1);
  expect(counters.aborts).toBe(1);
  expect(counters.pending).toBe(0);
  expect(releaseNever).toBeTypeOf('function');
  expect(harness.budget.inFlight).toBe(0);
  expect(harness.scheduler.stats.physicallyInFlight).toBe(0);
  expect(harness.scheduler.stats.timedOut).toBe(1);
  expect(harness.scheduler.stats.failed).toBe(0);
  expect(workflow.received, 'a timed-out query must not deliver a result').toEqual([]);
  await expect(reconciles).resolves.toBe(false);

  // The permit is truly restored: a second command reconciles immediately.
  await expect(harness.scheduler.schedule('cmd-ok')).resolves.toBe(true);
  expect(harness.scheduler.stats.completed).toBe(1);
  expect(counters.pending).toBe(0);
  expect(harness.budget.inFlight).toBe(0);
});

it('a late authoritative result resolving after the timeout never writes the actor', async () => {
  const rt = trackRuntime();
  const counters = physicalCounters();
  let releaseLate!: (value: CommandResultEvent) => void;
  const gateway = effectGateway((_fabId, _commandId, signal) => {
    counters.started += 1;
    counters.pending += 1;
    counters.peak = Math.max(counters.peak, counters.pending);
    return new Promise<CommandResultEvent | null>((resolve) => {
      // A non-cooperative transport: it *observes* the abort (cancellation reached
      // fetch) but still resolves its stale body later, after the timeout.
      signal.addEventListener('abort', () => {
        counters.aborts += 1;
        counters.pending -= 1;
      }, { once: true });
      releaseLate = (value: CommandResultEvent) => resolve(value);
    });
  });
  const harness = createSchedulerHarness(rt, { gateway, timeoutMs: 20 });
  schedulers.push(harness.scheduler);
  const workflow = harness.workflowFor('cmd-1');

  void harness.scheduler.schedule('cmd-1');
  await waitFor(() => harness.scheduler.stats.timedOut === 1 && harness.scheduler.stats.inFlight === 0);
  releaseLate(resultEvent({ revision: 5, outcome: 'succeeded' }));
  await sleep(40);
  console.error('[F4 counters] lateResolve -> receivedAfterTimeout=%d signalAborts=%d budgetInFlight=%d',
    workflow.received.length, counters.aborts, harness.budget.inFlight);
  expect(workflow.received, 'the stale result must not reach the actor').toEqual([]);
  expect(harness.scheduler.stats.completed).toBe(0);
  expect(harness.budget.inFlight).toBe(0);
  expect(counters.aborts).toBe(1);
});

it('dispose aborts every in-flight physical request, leaks no permit and produces no unhandled rejection', async () => {
  const rt = trackRuntime();
  const counters = physicalCounters();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const harness = createSchedulerHarness(rt, {
      gateway: effectGateway(hungFetch(counters)),
      timeoutMs: 60_000,
      maxConcurrent: 4,
    });
    schedulers.push(harness.scheduler);
    const pending = ['cmd-1', 'cmd-2', 'cmd-3'].map((commandId) => harness.scheduler.schedule(commandId));
    await waitFor(() => counters.started === 3 && counters.pending === 3);
    expect(harness.budget.inFlight).toBe(3);

    harness.scheduler.dispose();
    await expect(Promise.all(pending)).resolves.toEqual([false, false, false]);
    console.error('[F4 counters] dispose -> aborted=%d physicalPending=%d cancelled=%d budgetInFlight=%d',
      counters.aborts, counters.pending, harness.scheduler.stats.cancelled, harness.budget.inFlight);
    expect(counters.aborts).toBe(3);
    expect(counters.pending).toBe(0);
    expect(harness.budget.inFlight).toBe(0);
    expect(harness.scheduler.stats.inFlight).toBe(0);
    expect(harness.scheduler.stats.queued).toBe(0);
    expect(harness.scheduler.stats.cancelled).toBe(3);
    expect(harness.scheduler.stats.physicallyInFlight).toBe(0);
    await sleep(25);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
