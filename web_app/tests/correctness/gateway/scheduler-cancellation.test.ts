import { Effect } from 'effect';
import { FakeCommandEventSource, commandRecord, createTestFab, emptyRecoveryList } from '../../support/command-fakes.ts';
import { expect, it } from 'vitest';
import { createGatewayTestRuntime, createSchedulerHarness, effectGateway, hungFetch, physicalCounters, resultEvent, waitFor } from './harness.ts';

it('aborts a shared request only after its final waiter cancels', async () => {
  const rt = createGatewayTestRuntime();
  const counters = physicalCounters();
  const harness = createSchedulerHarness(rt, { gateway: effectGateway(hungFetch(counters)), timeoutMs: 10000 });
  try {
    const first = new AbortController();
    const second = new AbortController();
    const a = harness.scheduler.schedule('cmd-1', { signal: first.signal });
    const b = harness.scheduler.schedule('cmd-1', { signal: second.signal });
    await waitFor(() => counters.pending === 1);
    first.abort();
    expect((await a).status).toBe('cancelled');
    expect(counters.aborts).toBe(0);
    expect(counters.pending).toBe(1);
    second.abort();
    expect((await b).status).toBe('cancelled');
    await waitFor(() => counters.pending === 0 && harness.budget.inFlight === 0);
    expect(counters.aborts).toBe(1);
  } finally {
    harness.scheduler.dispose();
    await rt.dispose();
  }
});

it('removes a cancelled queued request without starting its HTTP request', async () => {
  const rt = createGatewayTestRuntime();
  const counters = physicalCounters();
  const harness = createSchedulerHarness(rt, { gateway: effectGateway(hungFetch(counters)), maxConcurrent: 1, timeoutMs: 10000 });
  try {
    const active = new AbortController();
    const queued = new AbortController();
    const a = harness.scheduler.schedule('first', { signal: active.signal });
    await waitFor(() => counters.pending === 1);
    const b = harness.scheduler.schedule('second', { signal: queued.signal });
    queued.abort();
    expect((await b).status).toBe('cancelled');
    expect(harness.scheduler.stats.queued).toBe(0);
    active.abort();
    await a;
    await waitFor(() => counters.pending === 0 && harness.budget.inFlight === 0);
    expect(counters.started).toBe(1);
  } finally {
    harness.scheduler.dispose();
    await rt.dispose();
  }
});


it('stopping recovery aborts its in-flight scheduler request and releases the physical permit', async () => {
  const counters = physicalCounters();
  const gateway = effectGateway(hungFetch(counters));
  const fab = createTestFab({
    source: new FakeCommandEventSource(),
    gateway: { ...gateway, listFabCommands: () => Effect.succeed(emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' })])) },
    reconcileTimeoutMs: 10000,
  });
  try {
    fab.runtime.start();
    await waitFor(() => counters.pending === 1);
    fab.runtime.stop();
    expect(counters.aborts).toBe(1);
    expect(counters.pending).toBe(0);
    expect(fab.runtime.physicalRequestStats.inFlight).toBe(0);
  } finally {
    await fab.dispose();
  }
});

it('stopping recovery preserves a shared explicit reconciliation waiter', async () => {
  let resolveRequest!: (value: ReturnType<typeof resultEvent>) => void;
  let aborted = false;
  const gateway = effectGateway((_fabId, _commandId, signal) => new Promise(resolve => {
    resolveRequest = resolve;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }));
  const fab = createTestFab({
    source: new FakeCommandEventSource(),
    gateway: { ...gateway, listFabCommands: () => Effect.succeed(emptyRecoveryList([commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing' })])) },
    reconcileTimeoutMs: 10000,
  });
  try {
    fab.runtime.start();
    await waitFor(() => typeof resolveRequest === 'function');
    const explicit = fab.runtime.reconcileCommand('cmd-1');
    fab.runtime.stop();
    expect(aborted).toBe(false);
    resolveRequest(resultEvent({ revision: 2, outcome: 'succeeded' }));
    await expect(explicit).resolves.toBe(true);
    expect(fab.runtime.getProjection('cmd-1')?.outcome).toBe('succeeded');
  } finally {
    await fab.dispose();
  }
});
