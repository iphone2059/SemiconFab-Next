import { Effect, Exit, Scope } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { COMMAND_RESULT_TOPIC, TELEMETRY_TOPIC } from '@/realtime/message-decoder';
import { createSseCommandEventSource, parseCommandCursor, parseCommandReplayGap } from '@/realtime/command-event-source.transport';
import { TelemetryRuntime, flattenTelemetryFrame, toolStatesFromValues } from '@/realtime/telemetry-runtime';
import { runCommandStream } from '@/runtime/command-stream';
import { type CommandTestRuntime, createCommandTestRuntime } from '../support/command-fakes.ts';

/** Stream consumers run on an Effect fiber; yield once so queued frames are delivered. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
});

function commandTransport(options: { capacity?: number; connectTimeoutMs?: number } = {}): TransportHarness {
  const harness = createCommandTestRuntime();
  const scope = Scope.makeUnsafe();
  const sources: FakeEventSource[] = [];
  const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
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
  cleanups.push(async () => {
    harness.host.runSync(Scope.close(scope, Exit.void));
    await flush();
    await harness.dispose();
  });
  return { harness, scope, sources, source };
}

it('decodes command SSE envelopes and closes the EventSource when the scoped consumers exit', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const received: number[] = [];
  runCommandStream(harness.host, scope, source.commandResults, (event) => received.push(event.revision));
  await flush();
  expect(sources[0].url).toBe('/api/v1/sites/site-1/commands/stream?fabId=fab-a');
  sources[0].emit(commandEnvelope(0));
  sources[0].emit(commandEnvelope(1));
  sources[0].emit({ topic: 'unknown', payload: {} });
  await flush();
  expect(received).toEqual([0, 1]);
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
  }), { epoch: 'epoch-1', sequence: 9 });
  expect(gap).toEqual({ epoch: 'epoch-2', sequence: 9, cursor: 'epoch-1:9' });
  // Malformed control frames still mean "reconcile"; they never throw.
  expect(parseCommandReplayGap('<html>', { sequence: 3 })).toEqual({ sequence: 3 });
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
  expect(gaps).toEqual([{ epoch: 'epoch-2', sequence: 8, cursor: 'epoch-1:8' }]);
  harness.host.runSync(Scope.close(scope, Exit.void));
  await flush();
  expect(sources[0].closed).toBe(true);
});

it('maps backend dirty control frames onto the bounded transport dirty contract', async () => {
  const { harness, scope, sources, source } = commandTransport();
  const dirty: Array<{ reason: string; droppedCount: number; epoch?: string; sequence?: number }> = [];
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
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'epoch-replaced', droppedCount: 1, epoch: 'epoch-2', sequence: 0, occurredAt: '2026-10-27T00:00:00Z' }));
  await flush();
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'store-fault', droppedCount: 1, epoch: 'epoch-2', sequence: 5, occurredAt: '2026-10-27T00:00:00Z' }));
  await flush();
  // Malformed dirty frames are ignored, never treated as command state.
  sources[0].emitNamed('dirty', JSON.stringify({ reason: 'nonsense' }));
  await flush();
  expect(dirty.map((signal) => signal.reason)).toEqual(['overflow', 'stale-generation', 'closed']);
  expect(dirty[0]).toMatchObject({ epoch: 'epoch-1', sequence: 12, droppedCount: 4 });
  expect(dirty[1].droppedCount).toBe(5);
  expect(dirty[2]).toMatchObject({ epoch: 'epoch-2', sequence: 5, droppedCount: 6 });
});

it('bounds the command bus and reports overflow instead of silently dropping frames', async () => {
  const { harness, scope, sources, source } = commandTransport({ capacity: 4 });
  const dirty: Array<{ reason: string; droppedCount: number }> = [];
  runCommandStream(harness.host, scope, source.dirty!, (signal) => dirty.push(signal));
  runCommandStream(harness.host, scope, source.commandResults, () => {});
  await flush();
  sources[0].onopen?.();
  for (let revision = 0; revision < 10; revision += 1) sources[0].emit(commandEnvelope(revision));
  await flush();
  expect(dirty.length).toBeGreaterThan(0);
  expect(dirty[0].reason).toBe('overflow');
  expect(dirty[0].droppedCount).toBeGreaterThanOrEqual(6);
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
