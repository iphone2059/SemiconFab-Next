import { Effect, Scope } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import { COMMAND_RESULT_TOPIC } from '@/realtime/message-decoder';
import {
  FakeCommandEventSource,
  type TestFab,
  commandResult,
  createCommandTestRuntime,
  createFabRuntime,
  createTestFab,
} from '../support/command-fakes.ts';

const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

/** Drain Effect's own already-queued scheduler tasks; runtime-owned timers are cleared synchronously. */
async function drainSchedulerTasks(): Promise<number> {
  let rounds = 0;
  while (vi.getTimerCount() > 0 && rounds < 8) {
    await vi.runOnlyPendingTimersAsync();
    rounds += 1;
  }
  return rounds;
}

it('CORE-014 leaves 0 timers, stream consumers, actors and scheduler work after dispose', async () => {
  vi.useFakeTimers();
  try {
    const source = new FakeCommandEventSource();
    const fab = createTestFab({ source });
    fabs.push(fab);
    const runtime = fab.runtime;
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    source.emit(commandResult({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded' }));
    expect(runtime.terminalWorkflowCount).toBe(1);
    // The terminal sweep timer is a runtime-owned timer.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(source.commandObservers).toBe(1);

    runtime.dispose();
    // Every consumer fiber/timer is stopped synchronously by Scope close.
    expect(source.commandObservers).toBe(0);
    expect(source.gapObservers).toBe(0);
    expect(source.reconnectObservers).toBe(0);
    expect(source.statusObservers).toBe(0);
    expect(source.dirtyObservers).toBe(0);
    expect(runtime.reconciliationStats.queued).toBe(0);
    expect(runtime.reconciliationStats.inFlight).toBe(0);
    expect(runtime.lifecycleCounts.finalized).toBe(runtime.lifecycleCounts.created);
    expect(runtime.workflowCount).toBe(0);

    await drainSchedulerTasks();
    expect(vi.getTimerCount()).toBe(0);
    // No injected work ran after teardown: the counters stay at zero.
    expect(source.commandObservers).toBe(0);

    await fab.harness.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('CORE-014 closes the scoped EventSource and its connect watchdog timer', async () => {
  vi.useFakeTimers();
  const harness = createCommandTestRuntime();
  try {
    interface FakeEventSourceLike {
      readonly url: string;
      closed: boolean;
      onopen: (() => void) | null;
      emit(payload: unknown): void;
    }
    const eventSources: FakeEventSourceLike[] = [];
    class FakeEventSource implements FakeEventSourceLike {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        eventSources.push(this);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      emit(payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify(payload) });
      }
      close(): void {
        this.closed = true;
      }
    }
    const runtime = createFabRuntime(harness, {
      lazyCommandSubscription: true,
      sourceFor: (_fabId, scope) =>
        createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
          host: {
            addFinalizer: (finalizer) => {
              harness.host.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
            },
          },
          eventSourceFactory: (url) => new FakeEventSource(url) as never,
        }),
    });
    runtime.start();
    runtime.registerAcceptedCommand('cmd-1');
    // The lazy bridge opens exactly one connection with a connect watchdog.
    await Promise.resolve();
    expect(eventSources).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    eventSources[0].onopen?.();
    eventSources[0].emit({
      topic: COMMAND_RESULT_TOPIC,
      sequence: 1,
      payload: { fabId: 'fab-a', commandId: 'cmd-1', revision: 1, outcome: 'executing', occurredAt: '2026-10-27T00:00:00Z' },
    });

    runtime.dispose();
    // The transport Scope finalizer closes the single EventSource synchronously.
    expect(eventSources[0].closed).toBe(true);
    await drainSchedulerTasks();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await harness.dispose();
    vi.useRealTimers();
  }
});
