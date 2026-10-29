import { Effect, Exit, Scope } from 'effect';
import type {
  CommandEventSource,
  CommandResultEvent,
} from '@/contracts/command-events.contract';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import { COMMAND_RESULT_TOPIC } from '@/realtime/message-decoder';
import { runCommandStream } from '@/runtime/command-stream';
import { type CommandTestRuntime, createCommandTestRuntime } from '../../../support/command-fakes.ts';

/**
 * ADR-010 (Round 2) contract shapes. Until the frozen contract change lands in
 * contracts/command-events.contract.ts these structural aliases let the RED
 * tests compile against the target API without weakening the assertions; the
 * GREEN step removes the casts.
 */
export interface RoundTwoCommandCursor {
  readonly epoch: string;
  readonly sequence: number;
}

export interface RoundTwoCursors {
  readonly observed?: RoundTwoCommandCursor;
  readonly delivered?: RoundTwoCommandCursor;
  readonly acknowledged?: RoundTwoCommandCursor;
}

export interface RoundTwoDirty {
  readonly reason: string;
  readonly droppedCount: number;
  readonly delivered?: RoundTwoCommandCursor;
  readonly gapStart?: number;
  readonly gapEnd?: number;
  readonly epoch?: string;
  readonly sequence?: number;
}

export interface RoundTwoCommandEventSource extends CommandEventSource {
  acknowledge(event: CommandResultEvent): void;
  readonly cursors: RoundTwoCursors;
}

export const asRoundTwoSource = (source: CommandEventSource): RoundTwoCommandEventSource =>
  source as unknown as RoundTwoCommandEventSource;

export interface FakeEventSourceOptions {
  readonly url: string;
}

export class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data: string; lastEventId?: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(payload: unknown, lastEventId?: string): void {
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId });
  }
  emitNamed(type: string, data: string, lastEventId?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId });
  }
  close(): void {
    this.closed = true;
  }
}

export const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const commandEnvelope = (input: {
  readonly revision: number;
  readonly commandId?: string;
  readonly fabId?: string;
  readonly outcome?: string;
}): unknown => ({
  topic: COMMAND_RESULT_TOPIC,
  sequence: input.revision,
  payload: {
    fabId: input.fabId ?? 'fab-a',
    commandId: input.commandId ?? 'cmd-1',
    revision: input.revision,
    outcome: input.outcome ?? 'executing',
    occurredAt: '2026-10-30T00:00:00Z',
  },
});

export interface TransportHarness {
  readonly harness: CommandTestRuntime;
  readonly scope: Scope.Closeable;
  readonly sources: FakeEventSource[];
  readonly source: RoundTwoCommandEventSource;
  readonly received: number[];
  readonly dirty: RoundTwoDirty[];
  readonly acked: CommandResultEvent[];
  readonly statuses: string[];
  readonly failures: unknown[];
  readonly gaps: unknown[];
  closeTransportScope(): void;
}

/** Real SSE transport with an injectable EventSource and a bounded capacity. */
export function createTransportHarness(options: { capacity?: number; connectTimeoutMs?: number } = {}): TransportHarness {
  const harness = createCommandTestRuntime();
  const scope = Scope.makeUnsafe();
  const sources: FakeEventSource[] = [];
  const raw = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
    host: {
      addFinalizer: (finalizer) => {
        harness.host.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
      },
    },
    eventSourceFactory: (url) => {
      const created = new FakeEventSource(url);
      sources.push(created);
      return created;
    },
    ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
    ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
  });
  const source = asRoundTwoSource(raw);
  const received: number[] = [];
  const dirty: RoundTwoDirty[] = [];
  const acked: CommandResultEvent[] = [];
  const statuses: string[] = [];
  const failures: unknown[] = [];
  const gaps: unknown[] = [];
  const acknowledge = (source as { acknowledge?: (event: CommandResultEvent) => void }).acknowledge;
  runCommandStream(harness.host, scope, source.commandResults, (event) => {
    received.push(event.revision);
    // ADR-010 §2: acknowledge only after the event has been applied. The RED run
    // on the baseline has no acknowledge capability yet; the guard keeps the
    // failure an assertion failure instead of a fiber defect.
    if (typeof acknowledge === 'function') acknowledge.call(source, event);
    acked.push(event);
  });
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal as unknown as RoundTwoDirty));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure));
  runCommandStream(harness.host, scope, source.gaps!, (gap) => gaps.push(gap));
  return {
    harness,
    scope,
    sources,
    source,
    received,
    dirty,
    acked,
    statuses,
    failures,
    gaps,
    closeTransportScope: () => {
      harness.host.runSync(Scope.close(scope, Exit.void));
    },
  };
}

export async function disposeTransportHarness(harness: TransportHarness): Promise<void> {
  harness.closeTransportScope();
  await flush();
  await harness.harness.dispose();
}
