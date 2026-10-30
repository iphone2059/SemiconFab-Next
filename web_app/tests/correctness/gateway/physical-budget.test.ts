/**
 * F4 / matrix-4 — the FAB-wide physical request budget (ADR-011 §2.2, CR-04/CR-08).
 *
 * The scheduler accepts the one shared PhysicalRequestBudget(4) object; FabRuntime
 * recovery journal/list requests must acquire the same budget. The invariant is
 * counted at the fake fetch layer, not from logical scheduler stats, so a leaked
 * timer/promise would show up as peak > 4.
 */
import { Effect } from 'effect';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type { FabReconciliationScheduler } from '@/runtime/fab-reconciliation-scheduler';
import { createPhysicalRequestBudget, type ReconciliationDropDiagnostic } from '@/runtime/fab-reconciliation-scheduler';
import { afterEach, expect, it } from 'vitest';
import {
  createGatewayTestRuntime,
  createSchedulerHarness,
  effectGateway,
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

interface PhysicalLayer {
  command: number;
  recovery: number;
  peak: number;
  overlapped: boolean;
  commandStarts: string[];
}

const physicalLayer = (): PhysicalLayer => ({ command: 0, recovery: 0, peak: 0, overlapped: false, commandStarts: [] });

function observe(layer: PhysicalLayer): void {
  const open = layer.command + layer.recovery;
  layer.peak = Math.max(layer.peak, open);
  if (layer.command > 0 && layer.recovery > 0) layer.overlapped = true;
}

it('8+ mixed-entry reconciliations share the budget with recovery requests: physical peak <= 4', async () => {
  const rt = trackRuntime();
  const layer = physicalLayer();
  const budget = createPhysicalRequestBudget(4);
  const commandGateway = effectGateway((_fabId, commandId, signal) => new Promise<CommandResultEvent | null>((resolve, reject) => {
    layer.command += 1;
    layer.commandStarts.push(commandId);
    observe(layer);
    const timer = setTimeout(() => {
      layer.command -= 1;
      resolve(resultEvent({ commandId, revision: 1 }));
    }, 18);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      layer.command -= 1;
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }, { once: true });
  }));
  const harness = createSchedulerHarness(rt, { gateway: commandGateway, budget, maxConcurrent: 8 });
  schedulers.push(harness.scheduler);

  // Two FabRuntime recovery requests (journal/list) acquire the SAME budget object.
  const recoveryRuns = [0, 1].map(() => rt.runtime.runPromise(budget.withPermit(
    Effect.tryPromise({
      try: (signal: AbortSignal) => new Promise<void>((resolve) => {
        layer.recovery += 1;
        observe(layer);
        const timer = setTimeout(() => {
          layer.recovery -= 1;
          resolve();
        }, 120);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          layer.recovery -= 1;
          resolve();
        }, { once: true });
      }),
      catch: () => undefined,
    }),
  )));
  // Recovery holds two slots before the reconciliation burst starts.
  await waitFor(() => layer.recovery === 2);

  // Mixed entry points of the single scheduler: track / gap replay / reconnect /
  // transport failure / queue overflow / explicit reconcile all funnel through
  // schedule(); they must not open a second worker pool or a second set of slots.
  const entryPoints = ['track', 'gap', 'reconnect', 'overflow', 'explicit', 'track', 'gap', 'reconnect', 'overflow', 'explicit'];
  const ids = entryPoints.map((_entryPoint, index) => 'cmd-' + index);
  const results = await Promise.all(ids.map((commandId) => harness.scheduler.schedule(commandId)));
  await Promise.all(recoveryRuns);

  console.error('[F4 counters] sharedBudget -> physicalPeak=%d physicalStarts=%d recoveryOverlap=%s completed=%d budgetInFlight=%d',
    layer.peak, layer.commandStarts.length, layer.overlapped, harness.scheduler.stats.completed, budget.inFlight);
  expect(layer.peak, 'physical requests across reconciliation + recovery must never exceed the shared budget').toBeLessThanOrEqual(4);
  expect(layer.peak).toBe(4);
  expect(layer.overlapped, 'recovery and reconciliation must actually share the same slots').toBe(true);
  expect(results.map((entry) => entry.status)).toEqual(Array.from({ length: 10 }, () => 'succeeded'));
  expect(layer.commandStarts).toHaveLength(10);
  expect(harness.scheduler.stats.completed).toBe(10);
  expect(harness.scheduler.stats.physicallyInFlight).toBe(0);
  expect(budget.inFlight).toBe(0);
});

it('queue capacity drops are reported through onDrop with no hidden retry buffer (CR-08)', async () => {
  const rt = trackRuntime();
  const counters = physicalCounters();
  const drops: ReconciliationDropDiagnostic[] = [];
  const budget = createPhysicalRequestBudget(4);
  const gateway = effectGateway((_fabId, _commandId, signal) =>
    new Promise<CommandResultEvent | null>((resolve) => {
      counters.started += 1;
      counters.pending += 1;
      signal.addEventListener('abort', () => {
        counters.aborts += 1;
        counters.pending -= 1;
        resolve(null);
      }, { once: true });
    }));
  const harness = createSchedulerHarness(rt, {
    gateway,
    budget,
    timeoutMs: 60_000,
    maxConcurrent: 1,
    maxQueued: 2,
    onDrop: (diagnostic) => drops.push(diagnostic),
  });
  schedulers.push(harness.scheduler);

  const pending = ['cmd-0', 'cmd-1', 'cmd-2', 'cmd-3', 'cmd-4', 'cmd-5']
    .map((commandId) => harness.scheduler.schedule(commandId));
  await waitFor(() => counters.started === 1);
  await waitFor(() => drops.length >= 4);

  console.error('[F4 counters] overflowDrop -> dropped=%d physicalStarts=%d queued=%d',
    drops.length, counters.started, harness.scheduler.stats.queued);
  expect(drops.length).toBe(4);
  expect(drops.every((diagnostic) => diagnostic.reason === 'queue-capacity')).toBe(true);
  expect(drops.map((diagnostic) => diagnostic.droppedTotal)).toEqual([1, 2, 3, 4]);
  expect(drops.every((diagnostic) => diagnostic.queued <= 2)).toBe(true);
  expect(harness.scheduler.stats.dropped).toBe(4);
  expect(harness.scheduler.stats.queued).toBeLessThanOrEqual(2);
  // The dropped commands are not silently retried inside the scheduler: recovered
  // intent belongs to FabRuntime Dirty + authoritative list recovery.
  await sleep(60);
  expect(counters.started, 'no hidden overflow retry may fire a second physical request').toBe(1);
  expect(harness.scheduler.stats.physicallyInFlight).toBe(1);

  harness.scheduler.dispose();
  // The four overflow victims settle 'dropped' at schedule time; the in-flight and
  // still-queued commands settle 'cancelled' when dispose interrupts them.
  await expect(Promise.all(pending)).resolves.toEqual([
    { commandId: 'cmd-0', status: 'dropped' },
    { commandId: 'cmd-1', status: 'dropped' },
    { commandId: 'cmd-2', status: 'dropped' },
    { commandId: 'cmd-3', status: 'dropped' },
    { commandId: 'cmd-4', status: 'cancelled' },
    { commandId: 'cmd-5', status: 'cancelled' },
  ]);
  expect(counters.pending).toBe(0);
  expect(budget.inFlight).toBe(0);
});

it('duplicate schedules for one command are single-flight (one physical request)', async () => {
  const rt = trackRuntime();
  const counters = physicalCounters();
  const harness = createSchedulerHarness(rt, {
    gateway: effectGateway(() => new Promise<CommandResultEvent | null>((resolve) => {
      counters.started += 1;
      counters.pending += 1;
      resolve(null);
    })),
    timeoutMs: 60_000,
  });
  schedulers.push(harness.scheduler);
  const first = harness.scheduler.schedule('cmd-1');
  const second = harness.scheduler.schedule('cmd-1');
  const third = harness.scheduler.reconcileCommand('cmd-1');
  // Duplicate schedules share the single-flight promise (the gateway answers null,
  // so the one authoritative result is a converged 'not-found').
  await expect(Promise.all([first, second, third])).resolves.toEqual([
    { commandId: 'cmd-1', status: 'not-found' },
    { commandId: 'cmd-1', status: 'not-found' },
    { commandId: 'cmd-1', status: 'not-found' },
  ]);
  expect(counters.started).toBe(1);
  expect(harness.scheduler.stats.scheduled).toBe(3);
});
