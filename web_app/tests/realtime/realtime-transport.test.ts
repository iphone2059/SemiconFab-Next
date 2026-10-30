import { Effect, Exit, Fiber, Scope } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandConfigurationError } from '@/contracts/command-config';
import { createPendingCommandEventSource } from '@/runtime/command-sources';
import { COMMAND_RESULT_TOPIC, TELEMETRY_TOPIC } from '@/realtime/message-decoder';
import {
  createSseCommandEventSource,
  parseCommandCursor,
  parseCommandReplayGap,
  type SseCommandEventSourceOptions,
} from '@/realtime/command-event-source.transport';
import { TelemetryRuntime, flattenTelemetryFrame, toolStatesFromValues } from '@/realtime/telemetry-runtime';
import { runCommandStream } from '@/runtime/command-stream';
import { type CommandTestRuntime, createCommandTestRuntime } from '../support/command-fakes.ts';

/** Stream consumers run on an Effect fiber; yield once so queued frames are delivered. */
const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeEventSource {
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

const commandEnvelope = (revision: number) => ({
  topic: COMMAND_RESULT_TOPIC,
  sequence: revision,
  payload: { fabId: 'fab-a', commandId: 'cmd-1', revision, outcome: revision === 0 ? 'accepted' : 'succeeded', occurredAt: '2026-10-27T00:00:00Z' },
});

interface TransportHarness {
  readonly harness: CommandTestRuntime;
  readonly scope: Scope.Closeable;
  readonly sources: FakeEventSource[];
  readonly source: ReturnType<typeof createSseCommandEventSource>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

interface CommandTransportOptions {
  readonly capacity?: number;
  readonly connectTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly maxConnectAttempts?: number;
  /** Test seam; omit for the environment default (browser EventSource factory). */
  readonly eventSourceFactory?: (url: string) => FakeEventSource;
  /** Model an environment without EventSource (R4-06a): no factory at all. */
  readonly withoutEventSource?: boolean;
}

function commandTransport(options: CommandTransportOptions = {}): TransportHarness {
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
          eventSourceFactory: options.eventSourceFactory ?? ((url: string) => {
            const created = new FakeEventSource(url);
            sources.push(created);
            return created;
          }),
        }),
    ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
    ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxConnectAttempts !== undefined ? { maxConnectAttempts: options.maxConnectAttempts } : {}),
  });
  cleanups.push(async () => {
    harness.host.runSync(Scope.close(scope, Exit.void));
    await flush();
    await harness.dispose();
  });
  return { harness, scope, sources, source };
}

it('decodes command SSE envelopes and turns an unknown topic into protocol-error Dirty', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const received: number[] = [];
  const dirty: Array<{ reason: string; gapStart?: number; delivered?: unknown }> = [];
  runCommandStream(harness.host, scope, source.commandResults, (event) => received.push(event.revision));
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  await flush();
  expect(sources[0].url).toBe('/api/v1/sites/site-1/commands/stream?fabId=fab-a');
  sources[0].emit(commandEnvelope(0), 'epoch-1:0');
  sources[0].emit(commandEnvelope(1), 'epoch-1:1');
  sources[0].emit({ topic: 'unknown', payload: {} }, 'epoch-1:2');
  await flush();
  expect(received).toEqual([0, 1]);
  // R3-04: an unknown topic is a protocol error, never a silently skipped frame.
  expect(dirty.at(-1)?.reason).toBe('protocol-error');
  expect(dirty.at(-1)?.gapStart).toBeUndefined();
  expect(dirty.at(-1)?.delivered).toBeUndefined();
});

it('reports SSE reconnection so runtimes can reconcile results outside the replay journal', async () => {
  const { harness, scope, sources, source } = commandTransport();
  let reconnects = 0;
  runCommandStream(harness.host, scope, source.reconnected!, () => { reconnects += 1; });
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  await flush();
  expect(reconnects).toBe(0);
  sources[0].onopen?.();
  await flush();
  expect(reconnects).toBe(1);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
});

it('parses the journal cursor and surfaces replay-gap as an explicit signal', () => {
  expect(parseCommandCursor('1f0e5c9a-0000-4000-8000-000000000001:42')).toEqual({
    epoch: '1f0e5c9a-0000-4000-8000-000000000001',
    sequence: 42,
  });
  expect(parseCommandCursor(undefined)).toEqual({});
  expect(parseCommandCursor('not-a-cursor')).toEqual({});
  const gap = parseCommandReplayGap(JSON.stringify({
    topic: 'command.result', replayGap: true, epoch: 'epoch-2',
    requestedLastEventId: 'epoch-1:9', firstRetainedSequence: 10, latestSequence: 12,
  }));
  // R4-04: the payload epoch is NEVER combined with the previous data frame's
  // sequence (an SSE control frame has no id line); requestedLastEventId is a
  // diagnostics-only cursor string and the parser manufactures no continuation.
  expect(gap).toEqual({ epoch: 'epoch-2', cursor: 'epoch-1:9' });
  // Malformed control frames still mean "reconcile"; they never throw and never
  // produce a usable position (=> List-only recovery).
  expect(parseCommandReplayGap('<html>')).toEqual({});
  expect(parseCommandReplayGap('{"replayGap":true}')).toEqual({});
});

it('keeps reconnected and emits gaps once per backend replay-gap control frame', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const gaps: unknown[] = [];
  let reconnects = 0;
  runCommandStream(harness.host, scope, source.gaps!, (gap) => gaps.push(gap));
  runCommandStream(harness.host, scope, source.reconnected!, () => { reconnects += 1; });
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  sources[0].emit(commandEnvelope(0), 'epoch-1:7');
  sources[0].emit(commandEnvelope(1), 'epoch-1:8');
  sources[0].onopen?.();
  sources[0].emitNamed('replay-gap', JSON.stringify({
    topic: 'command.result', replayGap: true, epoch: 'epoch-2', requestedLastEventId: 'epoch-1:8',
    firstRetainedSequence: 20, latestSequence: 22, occurredAt: '2026-10-27T00:00:00Z',
  }), 'epoch-1:8');
  await flush();
  expect(reconnects).toBe(1);
  expect(gaps).toEqual([{ epoch: 'epoch-2', cursor: 'epoch-1:8' }]);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
});

it('maps backend dirty control frames onto the bounded transport dirty contract', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const dirty: Array<{ reason: string; droppedCount: number; delivered?: { epoch: string; sequence: number }; gapStart?: number; gapEnd?: number }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  // Backend CommandDirtyDto: retention-trim / epoch-replaced / store-fault.
  // The dirty signal coalesces when its consumer lags; drain between frames so the
  // mapping of each server cause is observable (the monotonic droppedCount still
  // carries coalesced loss).
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'retention-trim', droppedCount: 4, epoch: 'epoch-1', sequence: 12, occurredAt: '2026-10-27T00:00:00Z' }));
  await flush();
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'epoch-replaced', droppedCount: 5, epoch: 'epoch-2', sequence: 0, occurredAt: '2026-10-27T00:00:00Z' }));
  await flush();
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'store-fault', droppedCount: 6, epoch: 'epoch-2', sequence: 5, occurredAt: '2026-10-27T00:00:00Z' }));
  await flush();
  // Malformed dirty control frames are never silently ignored (R3-04): they are
  // surfaced as invalid-control-frame Dirty so the runtime performs List recovery.
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'nonsense' }));
  await flush();
  sources[0].emitNamed('dirty', 'not-json-at-all');
  await flush();
  // ADR-010 §2/§6.4: server classes map onto the transport reasons; a server frame
  // never advances a local delivered cursor (the origin is unknown).
  expect(dirty.map((signal) => signal.reason)).toEqual([
    'server-overflow',
    'stale-generation',
    'store-fault',
    'invalid-control-frame',
    'invalid-control-frame',
  ]);
  expect(dirty[0]).toMatchObject({ droppedCount: 4 });
  expect(dirty[0].delivered).toBeUndefined();
  expect(dirty[0].gapStart).toBeUndefined();
  expect(dirty[1].droppedCount).toBe(5);
  expect(dirty[2]).toMatchObject({ droppedCount: 6 });
});

it('bounds the command bus and reports overflow instead of silently dropping frames', async () => {
  const { harness, scope, sources, source } = commandTransport({ capacity: 4 });
  const dirty: Array<{ reason: string; droppedCount: number; delivered?: unknown; gapStart?: number; gapEnd?: number }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  for (let revision = 0; revision < 10; revision += 1) {
    sources[0].emit(commandEnvelope(revision), 'epoch-1:' + revision);
  }
  await flush();
  expect(dirty.length).toBeGreaterThan(0);
  expect(dirty[0].reason).toBe('overflow');
  expect(dirty[0].droppedCount).toBeGreaterThanOrEqual(6);
  // R3-02: no ACK exists yet, so the safe recovery prefix is unknown (List path).
  expect(dirty[0].delivered).toBeUndefined();
  expect(dirty[0].gapStart).toBe(4);
  expect(dirty[0].gapEnd).toBe(9);
});

it('surfaces command-frame decode errors and keeps bounded payload-free diagnostics (R3-04)', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const dirty: Array<{ reason: string }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  // Malformed JSON with a usable id: decode-error, delivered/safe prefix unknown.
  sources[0].onmessage?.({ data: '{"topic": ', lastEventId: 'epoch-1:4' });
  await flush();
  expect(dirty.at(-1)?.reason).toBe('decode-error');
  sources[0].onmessage?.({ data: 'not-json', lastEventId: 'epoch-1:5' });
  await flush();
  expect(dirty.at(-1)?.reason).toBe('decode-error');
  const diagnostics = source.protocolDiagnostics;
  expect(diagnostics.length).toBeGreaterThanOrEqual(2);
  expect(diagnostics.length).toBeLessThanOrEqual(16);
  expect(diagnostics.every((entry) => typeof entry.reason === 'string')).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain('not-json');
  expect(source.cursors.acknowledged).toBeUndefined();
  expect(source.availability).toBe('ready');
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
});

it('latches the ACK state on replay-gap without manufacturing a cursor (R4-01/R4-04)', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const gaps: Array<{ epoch?: string; sequence?: number; cursor?: string }> = [];
  const dirty: Array<{ reason: string }> = [];
  runCommandStream(harness.host, scope, source.gaps!, (gap) => gaps.push(gap));
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  await flush();
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  sources[0].emit(commandEnvelope(0), 'old-epoch:7');
  sources[0].emit(commandEnvelope(1), 'old-epoch:8');
  await flush(5);
  // The control frame carries no id: line; the inherited lastEventId is the
  // PREVIOUS data frame (old epoch). Combining it with the payload's new epoch
  // would manufacture a cursor that skips events (R4-04).
  sources[0].emitNamed('replay-gap', JSON.stringify({
    topic: 'command.result', replayGap: true, epoch: 'new-epoch', requestedLastEventId: 'old-epoch:8',
    firstRetainedSequence: 20, latestSequence: 22, occurredAt: '2026-10-30T00:00:00Z',
  }), 'old-epoch:8');
  await flush(5);
  expect(gaps).toEqual([{ epoch: 'new-epoch', cursor: 'old-epoch:8' }]);
  expect(gaps[0].sequence).toBeUndefined();

  // The gap latches the ACK state with an unknown position: a journal cover cannot
  // release it and must surface uncovered-gap so the runtime retries with a List.
  source.cover({ epoch: 'new-epoch', sequence: 22 }, 'journal');
  await flush(5);
  expect(dirty.at(-1)?.reason).toBe('uncovered-gap');
  source.cover({ epoch: 'new-epoch', sequence: 22 }, 'list', source.lossGeneration);
  expect(source.cursors.acknowledged).toEqual({ epoch: 'new-epoch', sequence: 22 });
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
});

it('reports unavailable and never opens when the environment has no EventSource factory (R4-06a)', async () => {
  vi.stubGlobal('EventSource', undefined);
  const { harness, scope, source } = commandTransport({ withoutEventSource: true });
  const dirty: Array<{ reason: string }> = [];
  const statuses: string[] = [];
  const failures: Array<{ message: string }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure as { message: string }));
  await flush();
  // Availability is knowable before the lazy connection opens.
  expect(source.availability).toBe('unavailable');
  // P2-01: a source that can never connect starts (and reports) 'failed' without
  // waiting for a commandResults consumer, exactly like the pending source.
  expect(statuses).toEqual(['failed']);
  // The first consumer still receives the permanent-unavailability signals.
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush(5);
  expect(source.availability).toBe('unavailable');
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  expect(statuses).toEqual(['failed']);
  expect(failures.some((failure) => /unavailable/.test(failure.message))).toBe(true);
  expect(source.protocolDiagnostics.some((entry) => /unavailable/.test(entry.reason))).toBe(true);
  expect(source.cursors.acknowledged).toBeUndefined();
  expect(source.cursors.pendingAcknowledgements).toBe(0);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  // A deliberate close must never downgrade the permanent 'failed' to 'closed'.
  expect(statuses).toEqual(['failed']);
});

it('becomes permanently unavailable after bounded failed open attempts and stops retrying (R4-06a)', async () => {
  let attempts = 0;
  const { harness, scope, source } = commandTransport({
    eventSourceFactory: () => {
      attempts += 1;
      throw new Error('factory boom');
    },
    reconnectDelayMs: 0,
    maxConnectAttempts: 3,
  });
  const dirty: Array<{ reason: string }> = [];
  const statuses: string[] = [];
  const failures: Array<{ message: string }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure as { message: string }));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await expect.poll(() => attempts, { timeout: 2_000 }).toBe(3);
  await expect.poll(() => source.availability, { timeout: 2_000 }).toBe('unavailable');
  await flush(5);
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  expect(failures.some((failure) => /could not be opened/.test(failure.message))).toBe(true);
  // P2-01: each transient attempt is 'reconnecting' (never 'failed'), only the
  // exhausted budget is the permanent 'failed', published exactly once.
  expect(statuses).toEqual([
    'closed',
    'connecting',
    'reconnecting',
    'connecting',
    'reconnecting',
    'connecting',
    'failed',
  ]);
  expect(statuses.filter((status) => status === 'failed')).toHaveLength(1);
  expect(statuses).not.toContain('open');
  // Once permanently unavailable, no further open attempt is made (no loop).
  const attemptsAtUnavailable = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(attempts).toBe(attemptsAtUnavailable);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  // Ordinary close must not downgrade the permanent failure: the only 'closed' is
  // the initial idle replay, and nothing follows 'failed'.
  expect(statuses.filter((status) => status === 'closed')).toHaveLength(1);
  expect(statuses.at(-1)).toBe('failed');
});

it('retries a connect timeout through the bounded reconnect path, then reports unavailable (R4-06a)', async () => {
  const { harness, scope, sources, source } = commandTransport({
    connectTimeoutMs: 5,
    reconnectDelayMs: 0,
    maxConnectAttempts: 2,
  });
  const dirty: Array<{ reason: string }> = [];
  const statuses: string[] = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  expect(sources).toHaveLength(1);
  // The first attempt times out and is retried (not silently dropped); a connect
  // timeout is a transient attempt failure ('reconnecting'), never 'failed'.
  await expect.poll(() => source.availability, { timeout: 2_000 }).toBe('unavailable');
  await flush(5);
  expect(sources).toHaveLength(2);
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  expect(statuses).toEqual(['closed', 'connecting', 'reconnecting', 'connecting', 'failed']);
  expect(statuses).not.toContain('open');
  const createdAtUnavailable = sources.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sources).toHaveLength(createdAtUnavailable);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(statuses.at(-1)).toBe('failed');
});

it('strictly validates transport capacity/timeout options at construction (R4-07)', () => {
  const construct = (overrides: Partial<SseCommandEventSourceOptions>) => (): ReturnType<typeof createSseCommandEventSource> =>
    createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
      host: { addFinalizer: () => {} },
      eventSourceFactory: (target) => new FakeEventSource(target),
      ...overrides,
    });
  expect(construct({ capacity: 0 })).toThrow(CommandConfigurationError);
  expect(construct({ capacity: Number.NaN })).toThrow(CommandConfigurationError);
  expect(construct({ capacity: 2.5 })).toThrow(CommandConfigurationError);
  expect(construct({ capacity: Number.POSITIVE_INFINITY })).toThrow(CommandConfigurationError);
  expect(construct({ ackLedgerCapacity: 1.5 })).toThrow(CommandConfigurationError);
  expect(construct({ connectTimeoutMs: 0 })).toThrow(CommandConfigurationError);
  expect(construct({ connectTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(CommandConfigurationError);
  expect(construct({ reconnectDelayMs: -1 })).toThrow(CommandConfigurationError);
  expect(construct({ maxConnectAttempts: 0 })).toThrow(CommandConfigurationError);
  expect(construct({ maxConnectAttempts: 65 })).toThrow(CommandConfigurationError);
  expect(construct({
    capacity: 4,
    connectTimeoutMs: 1,
    reconnectDelayMs: 0,
    ackLedgerCapacity: 1,
    maxConnectAttempts: 1,
  })).not.toThrow();
});

it('feeds telemetry frames through the Worker and exposes renderer tool states', () => {
  const sources: FakeEventSource[] = [];
  const sent: unknown[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) { sent.push(message); },
    terminate: vi.fn(),
  };
  const runtime = new TelemetryRuntime({
    siteId: 'site-1',
    fabId: 'fab-a',
    url: '/api/v1/sites/site-1/fabs/fab-a/telemetry/stream',
    eventSourceFactory: (url) => { const value = new FakeEventSource(url); sources.push(value); return value; },
    workerFactory: () => worker,
  });
  runtime.start();
  // R5.4-03: the runtime consumes exactly the composition-root URL for its identity.
  expect(sources[0].url).toBe('/api/v1/sites/site-1/fabs/fab-a/telemetry/stream');
  expect(runtime.siteId).toBe('site-1');
  expect(runtime.fabId).toBe('fab-a');
  const samples = Array.from({ length: 16 }, (_, index) => ({
    entityId: `equipment-${index}`,
    values: { state: index % 4, utilization: 0.5 },
  }));
  sources[0].emit({ topic: TELEMETRY_TOPIC, sequence: 5, payload: { fabId: 'fab-a', sequence: 5, capturedAt: '2026-10-27T00:00:00Z', samples } });
  expect(sent[0]).toMatchObject({ type: 'frame', sequence: 5 });
  const values = (sent[0] as { values: Float32Array }).values;
  expect(values).toBeInstanceOf(Float32Array);
  expect(values).toHaveLength(32);
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 5, latest: values, generation: 0 } });
  expect(runtime.getSnapshot()?.sequence).toBe(5);
  expect(runtime.getToolStates()?.[0]).toBe('running');
  expect(runtime.getToolStates()?.[2]).toBe('down');
  runtime.stop();
  expect(worker.terminate).toHaveBeenCalled();
});

it('flattens only numeric sample fields into a fixed slot-keyed frame', () => {
  const frame = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 1, capturedAt: 'now',
    samples: [{ entityId: 'equipment-0', values: { state: 2, utilization: 0.25 } }],
  });
  expect(frame.values).toBeInstanceOf(Float32Array);
  expect(frame.values).toHaveLength(32);
  expect([...frame.values.slice(0, 2)]).toEqual([2, 0.25]);
  expect(frame.toolStates).toHaveLength(16);
  expect(frame.toolStates[0]).toBe('down');
  expect(frame.toolStates.slice(1)).toEqual(Array(15).fill('running'));
  expect(toolStatesFromValues(frame.values)).toHaveLength(16);
});

it('maps samples by stable equipment entity slot: shuffled order, duplicate/unknown ids, missing retention', () => {
  const first = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 1, capturedAt: 'now',
    samples: [
      { entityId: 'equipment-3', values: { state: 2, utilization: 0.5 } },
      { entityId: 'equipment-0', values: { state: 1, utilization: 0.25 } },
    ],
  });
  expect(first.toolStates[0]).toBe('idle');
  expect(first.toolStates[3]).toBe('down');

  const shuffled = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 2, capturedAt: 'now',
    samples: [
      { entityId: 'equipment-0', values: { state: 3, utilization: 0.1 } },
      { entityId: 'unknown-entity', values: { state: 2 } },
      { entityId: 'equipment-0', values: { state: 1 } },
      { entityId: 'equipment-3', values: { state: 0, utilization: 0.9 } },
    ],
  }, first.values);
  expect(shuffled.toolStates[0]).toBe('maint');
  expect(shuffled.toolStates[3]).toBe('running');
  expect(shuffled.toolStates[2]).toBe('running');
});

it('retains the previous state for entities missing from a later frame instead of resetting them', () => {
  const first = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 1, capturedAt: 'now',
    samples: [
      { entityId: 'equipment-0', values: { state: 2, utilization: 0.5 } },
      { entityId: 'equipment-7', values: { state: 3, utilization: 0.5 } },
    ],
  });
  const later = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 2, capturedAt: 'now',
    samples: [{ entityId: 'equipment-7', values: { state: 1, utilization: 0.5 } }],
  }, first.values);
  expect(later.toolStates[0]).toBe('down');
  expect(later.toolStates[7]).toBe('idle');
});

it('surfaces connection status and transport failures without fabricating command outcomes', async () => {
  const { harness, scope, sources, source } = commandTransport();
  // The lifecycle observer outlives the transport Scope so the close transition
  // itself is observable (the transport consumer fibers are interrupted by close).
  const statusScope = Scope.makeUnsafe();
  const failures: unknown[] = [];
  const statuses: string[] = [];
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure));
  runCommandStream(harness.host, statusScope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  // P2-01: the first status subscriber observes the idle lifecycle ('closed');
  // the first commandResults consumer then starts an attempt ('connecting').
  expect(statuses).toEqual(['closed', 'connecting']);
  sources[0].onopen?.();
  await flush();
  expect(statuses.at(-1)).toBe('open');
  sources[0].onerror?.({ message: 'network down' });
  await flush();
  // A transport failure is an observable signal and triggers the owned reconnect
  // path (one explicit connection at a time), never a command outcome.
  expect(statuses.at(-1)).toBe('reconnecting');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ message: 'command stream transport error' });
  // Scope close is a deliberate close: it must report 'closed', never 'open'.
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
  expect(statuses.at(-1)).toBe('closed');
  harness.host.runSync(Scope.close(statusScope, Exit.void));
});
describe('Round 5.1 / P2-01 command connection lifecycle', () => {
  it('starts closed, publishes connecting before the connection attempt and open on onopen', async () => {
    const { harness, scope, sources, source } = commandTransport();
    const statuses: string[] = [];
    runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
    await flush();
    // A transport that has not opened yet is deliberately idle ('closed'), not
    // 'connecting' and never 'failed'.
    expect(statuses).toEqual(['closed']);

    runCommandStream(harness.host, scope, source.commandResults, () => {});
    await flush();
    expect(sources).toHaveLength(1);
    // 'connecting' is published while the attempt is in progress and before onopen.
    expect(statuses).toEqual(['closed', 'connecting']);

    sources[0].onopen?.();
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open']);
  });

  it('treats a transient factory failure as reconnecting, retries and then opens', async () => {
    const created: FakeEventSource[] = [];
    let attempts = 0;
    const { harness, scope, source } = commandTransport({
      eventSourceFactory: (url) => {
        attempts += 1;
        if (attempts === 1) throw new Error('factory boom');
        const fake = new FakeEventSource(url);
        created.push(fake);
        return fake;
      },
      reconnectDelayMs: 5,
      maxConnectAttempts: 3,
    });
    const statuses: string[] = [];
    const failures: Array<{ message: string }> = [];
    runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
    runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure as { message: string }));
    runCommandStream(harness.host, scope, source.commandResults, () => {});
    await expect.poll(() => created.length, { timeout: 2_000 }).toBe(1);
    await flush(5);
    // A transient attempt failure is 'reconnecting' (a retry is scheduled), never
    // the permanent 'failed'; the retry publishes its own 'connecting'.
    expect(statuses).toEqual(['closed', 'connecting', 'reconnecting', 'connecting']);
    expect(statuses).not.toContain('failed');
    expect(failures.some((failure) => failure.message === 'command stream connection failed')).toBe(true);

    created[0].onopen?.();
    await flush();
    expect(statuses.at(-1)).toBe('open');
    expect(statuses).not.toContain('failed');
  });

  it('publishes reconnecting on an interruption and connecting/open when the retry succeeds', async () => {
    const { harness, scope, sources, source } = commandTransport({ reconnectDelayMs: 5, maxConnectAttempts: 3 });
    const statuses: string[] = [];
    runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
    runCommandStream(harness.host, scope, source.commandResults, () => {});
    await flush();
    sources[0].onopen?.();
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open']);

    sources[0].onerror?.({ message: 'network down' });
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'reconnecting']);
    expect(sources[0].closed).toBe(true);

    await expect.poll(() => sources.length, { timeout: 2_000 }).toBe(2);
    await flush(5);
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'reconnecting', 'connecting']);
    sources[1].onopen?.();
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'reconnecting', 'connecting', 'open']);
  });

  it('closes on the last commandResults consumer and re-opens for a new subscriber', async () => {
    const { harness, scope, sources, source } = commandTransport();
    const statuses: string[] = [];
    runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
    const firstConsumer = runCommandStream(harness.host, scope, source.commandResults, () => {});
    await flush();
    sources[0].onopen?.();
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open']);

    // The last consumer leaves: the owned connection closes and the lifecycle is
    // 'closed' (normal idle), never a forged 'open'/'failed'.
    harness.host.runSync(Fiber.interrupt(firstConsumer));
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(true);
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'closed']);

    // A new consumer establishes exactly one new connection: connecting -> open.
    const secondConsumer = runCommandStream(harness.host, scope, source.commandResults, () => {});
    await flush();
    expect(sources).toHaveLength(2);
    expect(statuses.at(-1)).toBe('connecting');
    sources[1].onopen?.();
    await flush();
    expect(statuses).toEqual(['closed', 'connecting', 'open', 'closed', 'connecting', 'open']);
    harness.host.runSync(Fiber.interrupt(secondConsumer));
  });

  it('scope finalizer publishes closed and never forges open', async () => {
    const { harness, scope, sources, source } = commandTransport();
    // Keep the lifecycle observer alive past the transport Scope close so the
    // finalizer transition is observable.
    const statusScope = Scope.makeUnsafe();
    const statuses: string[] = [];
    runCommandStream(harness.host, statusScope, source.connectionStatus!, (status) => statuses.push(status));
    runCommandStream(harness.host, scope, source.commandResults, () => {});
    await flush();
    sources[0].onopen?.();
    await flush();
    harness.host.runSync(Scope.close(scope, Exit.void));
    await flush();
    expect(sources[0].closed).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
    expect(statuses).not.toContain('failed');
    harness.host.runSync(Scope.close(statusScope, Exit.void));
  });

  it('reports the pending command source as failed with a real zero pending-ACK count', async () => {
    const runtime = createCommandTestRuntime();
    const scope = Scope.makeUnsafe();
    try {
      const pending = createPendingCommandEventSource();
      const statuses: string[] = [];
      runCommandStream(runtime.host, scope, pending.connectionStatus, (status) => statuses.push(status));
      await flush();
      // Same permanent meaning as a transport with no EventSource factory: 'failed',
      // never the idle 'closed' and never 'open'.
      expect(statuses).toEqual(['failed']);
      expect(pending.availability).toBe('unavailable');
      // Required contract field: a real zero (not a missing value).
      expect(pending.cursors).toEqual({ pendingAcknowledgements: 0 });
      expect(pending.cover({ epoch: 'epoch-1', sequence: 1 })).toMatchObject({
        status: 'insufficient',
        recovery: 'list',
      });
      expect(pending.cursors).toEqual({ pendingAcknowledgements: 0 });
    } finally {
      runtime.host.runSync(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});

