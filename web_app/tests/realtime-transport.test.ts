import { expect, it, vi } from 'vitest';
import { COMMAND_RESULT_TOPIC, TELEMETRY_TOPIC } from '../src/realtime/protocol/MessageDecoder';
import { createSseCommandEventSource } from '../src/realtime/transport/SseCommandEventSource';
import { createHttpCommandGateway } from '../src/realtime/transport/HttpCommandGateway';
import { submitEquipmentCommand } from '../src/api/mutations/commands.mutations';
import { TelemetryRuntime, flattenTelemetryFrame, toolStatesFromValues } from '../src/realtime/telemetry/TelemetryRuntime';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() { this.closed = true; }
}

const commandEnvelope = (revision: number) => ({
  topic: COMMAND_RESULT_TOPIC,
  sequence: revision,
  payload: { fabId: 'fab-a', commandId: 'cmd-1', revision, outcome: revision === 0 ? 'accepted' : 'succeeded', occurredAt: '2026-10-27T00:00:00Z' },
});

it('decodes command SSE envelopes and closes the EventSource on unsubscribe', () => {
  const sources: FakeEventSource[] = [];
  const source = createSseCommandEventSource('/api/v1/sites/site-1/commands/stream', {
    eventSourceFactory: (url) => { const value = new FakeEventSource(url); sources.push(value); return value; },
  });
  const received: number[] = [];
  const subscription = source.commandResult$.subscribe((event) => received.push(event.revision));
  expect(sources[0].url).toBe('/api/v1/sites/site-1/commands/stream');
  sources[0].emit(commandEnvelope(0));
  sources[0].emit(commandEnvelope(1));
  sources[0].emit({ topic: 'unknown', payload: {} });
  expect(received).toEqual([0, 1]);
  subscription.unsubscribe();
  expect(sources[0].closed).toBe(true);
});

it('queries authoritative command status and maps 404 to null', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async (input) => String(input).includes('missing')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ fabId: 'fab-a', commandId: 'cmd-1', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z' }), { status: 200 }),
  });
  await expect(gateway.getCommandStatus('fab-a', 'cmd-1')).resolves.toMatchObject({ revision: 2, outcome: 'succeeded' });
  await expect(gateway.getCommandStatus('fab-a', 'missing')).resolves.toBeNull();
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

it('submits equipment commands over HTTP', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    commandId: '11111111-1111-4111-8111-111111111111', siteId: 'site-1', fabId: 'fab-a',
    equipmentId: 'equipment-0', action: 'START', revision: 0, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z',
  }), { status: 202 }));
  await expect(submitEquipmentCommand(
    { siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-0', action: 'START', idempotencyKey: 'idem-1' },
    fetchImpl,
  )).resolves.toMatchObject({ commandId: '11111111-1111-4111-8111-111111111111', outcome: 'accepted' });
  expect(fetchImpl).toHaveBeenCalledWith('/api/v1/sites/site-1/commands', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'Idempotency-Key': 'idem-1' }),
  }));
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
    url: '/api/v1/sites/site-1/telemetry/stream',
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
  expect((sent[0] as { values: number[] }).values).toHaveLength(32);
  const values = (sent[0] as { values: number[] }).values;
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 5, latest: values, generation: 0 } });
  expect(runtime.getSnapshot()?.sequence).toBe(5);
  expect(runtime.getToolStates()?.[0]).toBe('running');
  expect(runtime.getToolStates()?.[2]).toBe('down');
  runtime.stop();
  expect(worker.terminate).toHaveBeenCalled();
});

it('flattens only numeric sample fields into a fixed frame', () => {
  const frame = flattenTelemetryFrame({
    fabId: 'fab-a', sequence: 1, capturedAt: 'now',
    samples: [{ entityId: 'equipment-0', values: { state: 2, utilization: 0.25 } }],
  });
  expect(frame.values).toHaveLength(32);
  expect(frame.values.slice(0, 2)).toEqual([2, 0.25]);
  expect(frame.toolStates).toEqual(['down']);
  expect(toolStatesFromValues(frame.values)).toHaveLength(16);
});
