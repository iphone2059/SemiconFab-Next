import { Effect, Exit, Scope } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandConfigurationError } from '@/contracts/command-config';
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
  source.cover({ epoch: 'new-epoch', sequence: 22 }, 'list');
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
  // The first consumer still receives the permanent-unavailability signals.
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush(5);
  expect(source.availability).toBe('unavailable');
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  expect(statuses).toContain('failed');
  expect(failures.some((failure) => /unavailable/.test(failure.message))).toBe(true);
  expect(source.protocolDiagnostics.some((entry) => /unavailable/.test(entry.reason))).toBe(true);
  expect(source.cursors.acknowledged).toBeUndefined();
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
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
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  expect(statuses).toContain('failed');
  expect(failures.some((failure) => /could not be opened/.test(failure.message))).toBe(true);
  // Once permanently unavailable, no further open attempt is made (no loop).
  const attemptsAtUnavailable = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(attempts).toBe(attemptsAtUnavailable);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
});

it('retries a connect timeout through the bounded reconnect path, then reports unavailable (R4-06a)', async () => {
  const { harness, scope, sources, source } = commandTransport({
    connectTimeoutMs: 5,
    reconnectDelayMs: 0,
    maxConnectAttempts: 2,
  });
  const dirty: Array<{ reason: string }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  expect(sources).toHaveLength(1);
  // The first attempt times out and is retried (not silently dropped).
  await expect.poll(() => source.availability, { timeout: 2_000 }).toBe('unavailable');
  expect(sources).toHaveLength(2);
  expect(dirty.some((signal) => signal.reason === 'transport-unavailable')).toBe(true);
  const createdAtUnavailable = sources.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sources).toHaveLength(createdAtUnavailable);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
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
    url: '/api/v1/sites/site-1/fabs/fab-a/telemetry/stream',
    eventSourceFactory: (url) => { const value = new FakeEventSource(url); sources.push(value); return value; },
    workerFactory: () => worker,
  });
  runtime.start();
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
  const failures: unknown[] = [];
  const statuses: string[] = [];
  runCommandStream(harness.host, scope, source.transportFailures!, (failure) => failures.push(failure));
  runCommandStream(harness.host, scope, source.connectionStatus!, (status) => statuses.push(status));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  expect(statuses).toEqual(['connecting']);
  sources[0].onopen?.();
  await flush();
  expect(statuses.at(-1)).toBe('open');
  sources[0].onerror?.({ message: 'network down' });
  await flush();
  // A transport failure is an observable signal and triggers the owned reconnect
  // path (one explicit connection at a time), never a command outcome.
  expect(statuses).toContain('reconnecting');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ message: 'command stream transport error' });
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
});
