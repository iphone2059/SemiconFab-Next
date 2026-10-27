import { expect, it } from 'vitest';
import { TelemetryRuntime } from '../src/realtime/telemetry/TelemetryRuntime';
import { createTelemetryWorkerHandler } from '../src/realtime/workers/telemetryWorker.logic';

function harness(deferred = false) {
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const replies: unknown[] = [];
  const source = { onopen: null as (() => void) | null, onmessage: null as ((event: { data: string }) => void) | null, close() {} };
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) {
      const result = handler.handle(message);
      if (result) { replies.push(result); if (!deferred) this.onmessage?.({ data: result }); }
    },
    terminate() {},
  };
  const runtime = new TelemetryRuntime({ url: 'fake', eventSourceFactory: () => source, workerFactory: () => worker });
  runtime.start(); source.onopen?.();
  const send = (sequence: number, state: number) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence, payload: { fabId: 'fab-a', sequence, capturedAt: '2026-10-27T00:00:00Z', samples: [{ entityId: 'equipment-0', values: { state, utilization: 0.5 } }] },
  }) });
  return { runtime, source, send, deliver: (index: number) => worker.onmessage?.({ data: replies[index] }) };
}

it('preserves wire sequence through the Worker and rejects older frames in the same connection', () => {
  const { runtime, send } = harness();
  send(100, 0); send(99, 2);
  expect(runtime.getSnapshot()?.sequence).toBe(100);
  expect(runtime.getToolStates()?.[0]).toBe('running');
  runtime.stop();
});

it('accepts the first frame after SSE reconnect restarts the wire sequence', () => {
  const { runtime, source, send } = harness();
  for (let sequence = 1; sequence <= 100; sequence++) send(sequence, 0);
  source.onopen?.();
  send(1, 2);
  expect(runtime.getSnapshot()?.sequence).toBe(1);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  runtime.stop();
});

it('ignores worker replies from an old connection and after stop', () => {
  const { runtime, source, send, deliver } = harness(true);
  send(100, 0);
  source.onopen?.();
  send(1, 2);
  deliver(1); deliver(0);
  expect(runtime.getSnapshot()?.sequence).toBe(1);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  runtime.stop(); deliver(0);
  expect(runtime.getSnapshot()).toBeUndefined();
});
