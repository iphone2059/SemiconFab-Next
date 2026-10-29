import { expect, it, vi } from 'vitest';
import { COMMAND_RESULT_TOPIC, TELEMETRY_TOPIC } from '@/realtime/message-decoder';
import { createSseCommandEventSource, parseCommandCursor, parseCommandReplayGap } from '@/realtime/command-event-source.transport';
import { TelemetryRuntime, flattenTelemetryFrame, toolStatesFromValues } from '@/realtime/telemetry-runtime';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data: string; lastEventId?: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data: string; lastEventId?: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(payload: unknown, lastEventId?: string) { this.onmessage?.({ data: JSON.stringify(payload), lastEventId }); }
  emitNamed(type: string, data: string, lastEventId?: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId });
  }
  close() { this.closed = true; }
}

const commandEnvelope = (revision: number) => ({
  topic: COMMAND_RESULT_TOPIC,
  sequence: revision,
  payload: { fabId: 'fab-a', commandId: 'cmd-1', revision, outcome: revision === 0 ? 'accepted' : 'succeeded', occurredAt: '2026-10-27T00:00:00Z' },
});

it('decodes command SSE envelopes and closes the EventSource on unsubscribe', () => {
  const sources: FakeEventSource[] = [];
  // The product stream is FAB-scoped and authorized by the fabId query param.
  const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
    eventSourceFactory: (url) => { const value = new FakeEventSource(url); sources.push(value); return value; },
  });
  const received: number[] = [];
  const subscription = source.commandResult$.subscribe((event) => received.push(event.revision));
  expect(sources[0].url).toBe('/api/v1/sites/site-1/commands/stream?fabId=fab-a');
  sources[0].emit(commandEnvelope(0));
  sources[0].emit(commandEnvelope(1));
  sources[0].emit({ topic: 'unknown', payload: {} });
  expect(received).toEqual([0, 1]);
  subscription.unsubscribe();
  expect(sources[0].closed).toBe(true);
});

it('reports SSE reconnection so runtimes can reconcile results outside the replay journal', () => {
  const sources: FakeEventSource[] = [];
  const source = createSseCommandEventSource('fake', { eventSourceFactory: url => { const value = new FakeEventSource(url); sources.push(value); return value; } });
  let reconnects = 0;
  const changes = source.reconnected$?.subscribe(() => { reconnects++; });
  const results = source.commandResult$.subscribe(() => {});
  sources[0].onopen?.();
  expect(reconnects).toBe(0);
  sources[0].onopen?.();
  expect(reconnects).toBe(1);
  results.unsubscribe(); changes?.unsubscribe();
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

it('keeps reconnected$ and emits gaps$ once per backend replay-gap control frame', () => {
  const sources: FakeEventSource[] = [];
  const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream?fabId=fab-a', {
    eventSourceFactory: (url) => { const value = new FakeEventSource(url); sources.push(value); return value; },
  });
  const gaps: unknown[] = [];
  let reconnects = 0;
  const gapSubscription = source.gaps$?.subscribe((gap) => gaps.push(gap));
  const reconnectSubscription = source.reconnected$?.subscribe(() => { reconnects++; });
  const results = source.commandResult$.subscribe(() => {});
  sources[0].onopen?.();
  // Normal frames carry the journal cursor in the SSE id line.
  sources[0].emit(commandEnvelope(0), 'epoch-1:7');
  sources[0].emit(commandEnvelope(1), 'epoch-1:8');
  // A reconnect followed by one replay-gap control frame (no id line of its own).
  sources[0].onopen?.();
  sources[0].emitNamed('replay-gap', JSON.stringify({
    topic: 'command.result', replayGap: true, epoch: 'epoch-2', requestedLastEventId: 'epoch-1:8',
    firstRetainedSequence: 20, latestSequence: 22, occurredAt: '2026-10-27T00:00:00Z',
  }), 'epoch-1:8');
  expect(reconnects).toBe(1);
  expect(gaps).toEqual([{ epoch: 'epoch-2', sequence: 8, cursor: 'epoch-1:8' }]);
  results.unsubscribe(); gapSubscription?.unsubscribe(); reconnectSubscription?.unsubscribe();
  expect(sources[0].closed).toBe(true);
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
  // The Worker command carries a binary typed-array payload, not a number[].
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
  // Slots without samples on the first frame keep the legacy running default.
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

  // Same entities in shuffled order (plus an unknown + a duplicate) hit the same slots.
  const shuffled = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 2, capturedAt: 'now',
    samples: [
      { entityId: 'equipment-0', values: { state: 3, utilization: 0.1 } },
      { entityId: 'unknown-entity', values: { state: 2 } },
      { entityId: 'equipment-0', values: { state: 1 } },
      { entityId: 'equipment-3', values: { state: 0, utilization: 0.9 } },
    ],
  }, first.values);
  expect(shuffled.toolStates[0]).toBe('maint'); // first occurrence wins; duplicate ignored
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
  expect(later.toolStates[0]).toBe('down'); // kept, not defaulted back to running
  expect(later.toolStates[7]).toBe('idle');
});
