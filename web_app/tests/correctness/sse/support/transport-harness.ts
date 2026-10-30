import { Effect, Exit, Scope } from 'effect';
import type {
  CommandCoverAuthority,
  CommandCursor,
  CommandEventSource,
  CommandProtocolDiagnostic,
  CommandResultEvent,
  CommandSourceCursors,
  CommandStreamDirty,
} from '@/contracts/command-events.contract';
import { createSseCommandEventSource } from '@/realtime/command-event-source.transport';
import { COMMAND_RESULT_TOPIC } from '@/realtime/message-decoder';
import { runCommandStream } from '@/runtime/command-stream';
import { type CommandTestRuntime, createCommandTestRuntime } from '../../../support/command-fakes.ts';

/**
 * Round 3/4 (ADR-010 §6.2/§6.4) SSE test fixtures.
 *
 * The harness uses the real SSE transport with an injectable EventSource and lets
 * each test choose whether deliveries are immediately acknowledged (simulating an
 * actor that applies synchronously) or acknowledged manually to exercise the
 * ordered ACK ledger / cover() safe-watermark semantics.
 */
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
  /** Raw (possibly malformed) data frame, bypassing JSON.stringify. */
  emitData(data: string, lastEventId?: string): void {
    this.onmessage?.({ data, lastEventId });
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

/** SSE id line for the Site journal cursor (epoch:sequence). */
export const cursorId = (epoch: string, sequence: number): string => epoch + ':' + sequence;

export interface TransportHarness {
  readonly harness: CommandTestRuntime;
  readonly scope: Scope.Closeable;
  readonly sources: FakeEventSource[];
  readonly source: CommandEventSource;
  readonly received: CommandResultEvent[];
  readonly receivedRevisions: number[];
  readonly dirty: CommandStreamDirty[];
  readonly acked: CommandResultEvent[];
  readonly statuses: string[];
  readonly failures: unknown[];
  readonly gaps: unknown[];
  /** Latest bounded protocol diagnostics snapshot (payload-free). */
  diagnostics(): readonly CommandProtocolDiagnostic[];
  /** Conservative cursor snapshot of the real transport. */
  cursors(): CommandSourceCursors;
  /**
   * Authoritative recovery safe watermark (ADR-010 §6.2 / R4-01). The authority
   * decides whether an ACK-blocked untracked position can be released: an unknown
   * or cross-epoch position requires 'list'.
   */
  cover(cursor: CommandCursor, authority?: CommandCoverAuthority): void;
  /** Manually acknowledge one delivered event (ordered-ledger tests). */
  acknowledge(event: CommandResultEvent): void;
  closeTransportScope(): void;
}

export interface TransportHarnessOptions {
  readonly capacity?: number;
  readonly connectTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly maxConnectAttempts?: number;
  readonly ackLedgerCapacity?: number;
  /** Default true: acknowledge every delivered event immediately (applied actor). */
  readonly autoAck?: boolean;
  /** Model an environment without EventSource: omit the injectable factory (R4-06). */
  readonly withoutEventSource?: boolean;
}

/** Real SSE transport with an injectable EventSource and a bounded capacity. */
export function createTransportHarness(options: TransportHarnessOptions = {}): TransportHarness {
  const harness = createCommandTestRuntime();
  const scope = Scope.makeUnsafe();
  const sources: FakeEventSource[] = [];
  const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
    host: {
      addFinalizer: (finalizer) => {
        harness.host.runSync(Scope.addFinalizer(scope, Effect.sync(finalizer)));
      },
    },
    ...(options.withoutEventSource
      ? {}
      : {
          eventSourceFactory: (url: string) => {
            const created = new FakeEventSource(url);
            sources.push(created);
            return created;
          },
        }),
    ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
    ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxConnectAttempts !== undefined ? { maxConnectAttempts: options.maxConnectAttempts } : {}),
    ...(options.ackLedgerCapacity !== undefined ? { ackLedgerCapacity: options.ackLedgerCapacity } : {}),
  });
  const autoAck = options.autoAck !== false;
  const received: CommandResultEvent[] = [];
  const receivedRevisions: number[] = [];
  const dirty: CommandStreamDirty[] = [];
  const acked: CommandResultEvent[] = [];
  const statuses: string[] = [];
  const failures: unknown[] = [];
  const gaps: unknown[] = [];
  // Observe every signal channel before the commandResults consumer opens the lazy
  // connection, so even synchronous open-time signals (e.g. transport-unavailable)
  // are observable (R4-06).
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure));
  runCommandStream(harness.host, scope, source.gaps!, (gap) => gaps.push(gap));
  runCommandStream(harness.host, scope, source.commandResults, (event) => {
    received.push(event);
    receivedRevisions.push(event.revision);
    // Simulate an actor that applied the revision synchronously; ordered-ledger
    // tests disable this and call acknowledge()/cover() explicitly.
    if (autoAck) {
      source.acknowledge(event);
      acked.push(event);
    }
  });
  return {
    harness,
    scope,
    sources,
    source,
    received,
    receivedRevisions,
    dirty,
    acked,
    statuses,
    failures,
    gaps,
    diagnostics: () => source.protocolDiagnostics,
    cursors: () => source.cursors,
    cover: (cursor, authority) => source.cover(cursor, authority, source.lossGeneration),
    acknowledge: (event) => {
      source.acknowledge(event);
      acked.push(event);
    },
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
