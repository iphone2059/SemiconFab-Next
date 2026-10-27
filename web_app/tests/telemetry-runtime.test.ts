import { expect, it } from 'vitest';
import type { TelemetryFrame } from '../src/application/contracts/CommandEvents';
import type { TelemetryWorkerEvent } from '../src/realtime/workers/telemetryWorker.logic';
import { TelemetryRuntime, mergeTelemetryFrames } from '../src/realtime/telemetry/TelemetryRuntime';
import { createTelemetryWorkerHandler } from '../src/realtime/workers/telemetryWorker.logic';

interface PostedCommand {
  readonly type?: string;
  readonly sequence?: number;
  readonly values?: Float32Array;
  readonly generation?: number;
}

function harness(deferred = false) {
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const replies: TelemetryWorkerEvent[] = [];
  const commands: PostedCommand[] = [];
  let terminated = false;
  const source = { onopen: null as (() => void) | null, onmessage: null as ((event: { data: string }) => void) | null, close() {} };
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) {
      commands.push(message as PostedCommand);
      const result = handler.handle(message);
      if (result) { replies.push(result); if (!deferred) this.onmessage?.({ data: result }); }
    },
    terminate() { terminated = true; },
  };
  const runtime = new TelemetryRuntime({ url: 'fake', fabId: 'fab-a', eventSourceFactory: () => source, workerFactory: () => worker });
  runtime.start(); source.onopen?.();
  const send = (sequence: number, state: number) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence, payload: { fabId: 'fab-a', sequence, capturedAt: '2026-10-27T00:00:00Z', samples: [{ entityId: 'equipment-0', values: { state, utilization: 0.5 } }] },
  }) });
  const sendSamples = (sequence: number, samples: Array<{ entityId: string; state: number; utilization?: number }>) =>
    source.onmessage?.({ data: JSON.stringify({
      topic: 'telemetry.frame', sequence,
      payload: {
        fabId: 'fab-a', sequence, capturedAt: '2026-10-27T00:00:00Z',
        samples: samples.map((sample) => ({
          entityId: sample.entityId,
          values: { state: sample.state, utilization: sample.utilization ?? 0.5 },
        })),
      },
    }) });
  const deliver = (index: number) => worker.onmessage?.({ data: replies[index] });
  const frames = () => commands.filter((command) => command.type === 'frame');
  const wasTerminated = () => terminated;
  return { runtime, source, worker, send, sendSamples, deliver, commands, replies, frames, wasTerminated };
}

it('merges telemetry frames by entityId with incoming overrides and stable order', () => {
  const base: TelemetryFrame = {
    fabId: 'fab-a', sequence: 1, capturedAt: '2026-10-27T00:00:00Z',
    samples: [
      { entityId: 'equipment-0', values: { state: 0, utilization: 0.1 } },
      { entityId: 'equipment-2', values: { state: 2 } },
    ],
  };
  const incoming: TelemetryFrame = {
    fabId: 'fab-a', sequence: 5, capturedAt: '2026-10-27T00:00:05Z',
    samples: [
      { entityId: 'equipment-2', values: { state: 3 } }, // override in base position
      { entityId: 'equipment-1', values: { state: 1 } }, // appended after base entities
      { entityId: 'equipment-1', values: { state: 9 } }, // duplicate after first occurrence ignored
    ],
  };
  const merged = mergeTelemetryFrames(base, incoming);
  expect(merged.fabId).toBe('fab-a');
  expect(merged.sequence).toBe(5);
  expect(merged.capturedAt).toBe('2026-10-27T00:00:05Z');
  expect(merged.samples).toEqual([
    { entityId: 'equipment-0', values: { state: 0, utilization: 0.1 } },
    { entityId: 'equipment-2', values: { state: 3 } },
    { entityId: 'equipment-1', values: { state: 1 } },
  ]);
  // Pure and non-destructive: the input frames keep their own samples.
  expect(base.samples[1].values.state).toBe(2);
  expect(incoming.samples).toHaveLength(3);
});

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

it('rejects a telemetry frame addressed to another FAB', () => {
  const { runtime, source } = harness();
  source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence: 1,
    payload: { fabId: 'fab-b', sequence: 1, capturedAt: 'now', samples: [{ entityId: 'equipment-0', values: { state: 2 } }] },
  }) });
  expect(runtime.getSnapshot()).toBeUndefined();
  source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence: 1,
    payload: { fabId: 'fab-a', sequence: 1, capturedAt: 'now', samples: [{ entityId: 'equipment-0', values: { state: 2 } }] },
  }) });
  expect(runtime.getSnapshot()?.sequence).toBe(1);
  expect(runtime.fabId).toBe('fab-a');
  runtime.stop();
});

it('maps shuffled telemetry samples to stable equipment slots instead of array positions', () => {
  const { runtime, sendSamples } = harness();
  // Entity order deliberately reversed: slot identity must come from entityId.
  sendSamples(1, [
    { entityId: 'equipment-2', state: 2 },
    { entityId: 'equipment-0', state: 1 },
  ]);
  expect(runtime.getToolStates()?.[0]).toBe('idle');
  expect(runtime.getToolStates()?.[2]).toBe('down');
  expect(runtime.getToolStates()?.[1]).toBe('running');

  sendSamples(2, [
    { entityId: 'equipment-0', state: 3 },
    { entityId: 'equipment-2', state: 0 },
  ]);
  expect(runtime.getToolStates()?.[0]).toBe('maint');
  expect(runtime.getToolStates()?.[2]).toBe('running');
  runtime.stop();
});

it('retains previous tool state when an entity is missing from a later frame', () => {
  const { runtime, sendSamples } = harness();
  sendSamples(1, [
    { entityId: 'equipment-0', state: 2 },
    { entityId: 'equipment-5', state: 1 },
  ]);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  expect(runtime.getToolStates()?.[5]).toBe('idle');

  // Only equipment-5 is sampled next: equipment-0 must keep 'down', not reset to running.
  sendSamples(2, [{ entityId: 'equipment-5', state: 0 }]);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  expect(runtime.getToolStates()?.[5]).toBe('running');
  runtime.stop();
});

it('ignores unknown and duplicate telemetry entity ids', () => {
  const { runtime, sendSamples } = harness();
  sendSamples(1, [
    { entityId: 'unknown-equipment', state: 2 },
    { entityId: 'equipment-16', state: 2 }, // outside the 16 render slots
    { entityId: 'equipment-4', state: 3 },
    { entityId: 'equipment-4', state: 0 }, // duplicate: first occurrence wins
  ]);
  expect(runtime.getToolStates()?.[4]).toBe('maint');
  expect(runtime.getToolStates()?.filter((state) => state === 'down')).toHaveLength(0);
  runtime.stop();
});

it('keeps retained state across an SSE reconnect frame that omits sampled entities', () => {
  const { runtime, source, sendSamples } = harness();
  sendSamples(1, [{ entityId: 'equipment-3', state: 2 }]);
  expect(runtime.getToolStates()?.[3]).toBe('down');
  source.onopen?.();
  sendSamples(1, [{ entityId: 'equipment-4', state: 1 }]);
  expect(runtime.getSnapshot()?.sequence).toBe(1);
  expect(runtime.getToolStates()?.[3]).toBe('down');
  expect(runtime.getToolStates()?.[4]).toBe('idle');
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

it('stores the Worker reply Float32Array directly instead of converting it', () => {
  const { runtime, send, deliver, replies } = harness(true);
  send(1, 2);
  deliver(0);
  const reply = replies[0] as Extract<TelemetryWorkerEvent, { type: 'frame-written' }>;
  expect(reply.latest).toBeInstanceOf(Float32Array);
  // No Float32Array.from: the binary reply array becomes the snapshot as-is.
  expect(runtime.getSnapshot()?.values).toBe(reply.latest);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  runtime.stop();
});

it('submits only one bounded pending frame while a Worker reply is deferred (latest-wins)', () => {
  const { runtime, send, deliver, frames } = harness(true);
  send(1, 0); // submitted, reply deferred
  send(2, 1); // pending
  send(3, 2); // merged into pending: same entity takes the newest value
  expect(frames().map((frame) => frame.sequence)).toEqual([1]);
  deliver(0); // reply for frame 1 unblocks exactly one newer frame
  expect(frames().map((frame) => frame.sequence)).toEqual([1, 3]);
  expect(frames()[1]?.values?.[0]).toBe(2);
  deliver(1);
  expect(runtime.getSnapshot()?.sequence).toBe(3);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  runtime.stop();
});

it('merges sparse pending frames so delta updates survive Worker backpressure', () => {
  const { runtime, sendSamples, deliver, frames } = harness(true);
  sendSamples(1, [{ entityId: 'equipment-0', state: 0 }]); // in flight, reply deferred
  sendSamples(2, [{ entityId: 'equipment-1', state: 2 }]); // pending delta
  sendSamples(3, [{ entityId: 'equipment-2', state: 1 }]); // merged into pending
  sendSamples(4, [{ entityId: 'equipment-3', state: 3 }]); // merged into pending
  expect(frames().map((frame) => frame.sequence)).toEqual([1]);
  deliver(0); // flush exactly one merged pending frame
  const submitted = frames();
  expect(submitted.map((frame) => frame.sequence)).toEqual([1, 4]);
  // equipment-1/2/3 updates survive the merge; equipment-0 is inherited from
  // the last submitted frame instead of being lost by replacement.
  const values = submitted[1].values!;
  expect(values[0]).toBe(0);
  expect(values[2]).toBe(2);
  expect(values[4]).toBe(1);
  expect(values[6]).toBe(3);
  deliver(1);
  expect(runtime.getSnapshot()?.sequence).toBe(4);
  expect(runtime.getToolStates()?.[0]).toBe('running');
  expect(runtime.getToolStates()?.[1]).toBe('down');
  expect(runtime.getToolStates()?.[2]).toBe('idle');
  expect(runtime.getToolStates()?.[3]).toBe('maint');
  runtime.stop();
});

it('still collapses full-snapshot frames to one latest pending frame during backpressure', () => {
  const { runtime, sendSamples, deliver, frames } = harness(true);
  sendSamples(1, [
    { entityId: 'equipment-0', state: 0 },
    { entityId: 'equipment-1', state: 0 },
  ]);
  sendSamples(2, [
    { entityId: 'equipment-0', state: 1 },
    { entityId: 'equipment-1', state: 2 },
  ]);
  sendSamples(3, [
    { entityId: 'equipment-0', state: 3 },
    { entityId: 'equipment-1', state: 1 },
  ]);
  expect(frames().map((frame) => frame.sequence)).toEqual([1]);
  deliver(0);
  expect(frames().map((frame) => frame.sequence)).toEqual([1, 3]);
  const values = frames()[1].values!;
  expect(values[0]).toBe(3); // full snapshots: the newest value wins per entity
  expect(values[2]).toBe(1);
  deliver(1);
  expect(runtime.getSnapshot()?.sequence).toBe(3);
  expect(runtime.getToolStates()?.[0]).toBe('maint');
  expect(runtime.getToolStates()?.[1]).toBe('idle');
  runtime.stop();
});

it('drops the pending frame on SSE reopen and starts a new Worker generation', () => {
  const { runtime, source, send, deliver, frames } = harness(true);
  send(1, 2); // in flight
  send(2, 0); // pending while the reply is deferred
  send(3, 1); // merged into the pending frame, still dropped by the reconnect
  source.onopen?.();
  expect(runtime.getSnapshot()).toBeUndefined();
  send(1, 1); // first frame of the new connection is submitted immediately
  expect(frames().map((frame) => frame.sequence)).toEqual([1, 1]);
  const generations = frames().map((frame) => frame.generation!);
  expect(generations[1]).toBeGreaterThan(generations[0]);
  // The old connection's deferred reply is ignored and the dropped pending
  // frame is never replayed after the reset.
  deliver(0);
  expect(runtime.getSnapshot()).toBeUndefined();
  deliver(1);
  expect(runtime.getSnapshot()?.sequence).toBe(1);
  expect(runtime.getToolStates()?.[0]).toBe('idle');
  runtime.stop();
});

it('stop disposes pending/in-flight work and detaches both callbacks', () => {
  const { runtime, send, deliver, frames, wasTerminated } = harness(true);
  send(1, 0); // in flight
  send(2, 2); // pending
  runtime.stop();
  expect(wasTerminated()).toBe(true);
  expect(runtime.getSnapshot()).toBeUndefined();
  deliver(0); // late reply after stop
  send(3, 1); // late SSE frame after stop
  expect(runtime.getSnapshot()).toBeUndefined();
  expect(frames().map((frame) => frame.sequence)).toEqual([1]);
});

it('accepts ArrayBuffer views and legacy number[] worker replies', () => {
  const { runtime, worker } = harness(true);
  // The harness opens the SSE source once during setup, so the active Worker
  // generation is 1 (setup reset) before any frame is submitted.
  const generation = 1;
  const view = Float64Array.from({ length: 32 }, (_, index) => (index === 0 ? 2 : 0));
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 1, latest: view, generation } });
  expect(runtime.getSnapshot()?.values).toBeInstanceOf(Float32Array);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  const legacy = Array.from({ length: 32 }, (_, index) => (index === 0 ? 1 : 0));
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 2, latest: legacy, generation } });
  expect(runtime.getSnapshot()?.sequence).toBe(2);
  expect(runtime.getToolStates()?.[0]).toBe('idle');
  runtime.stop();
});
