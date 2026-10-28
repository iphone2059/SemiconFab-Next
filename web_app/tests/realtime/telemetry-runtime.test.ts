import { expect, it, vi } from 'vitest';
import type { TelemetryFrame, TelemetrySample } from '../../src/application/contracts/CommandEvents';
import type { TelemetryWorkerEvent } from '../../src/realtime/workers/telemetryWorker.logic';
import { TelemetryRuntime, mergeTelemetryFrames } from '../../src/realtime/telemetry/TelemetryRuntime';
import { createTelemetryWorkerHandler } from '../../src/realtime/workers/telemetryWorker.logic';

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

interface RecoveryWorker {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminated: boolean;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Worker-fault harness: replies can be withheld, postMessage failures injected and
 * every Worker generation created by a rebuild is observable.
 */
function recoveryHarness(options: { deliverNow?: boolean; workerTimeoutMs?: number; failedConstructions?: readonly number[]; failedResets?: readonly number[] } = {}) {
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const commands: PostedCommand[] = [];
  const replies: TelemetryWorkerEvent[] = [];
  const workers: RecoveryWorker[] = [];
  let deliverNow = options.deliverNow !== false;
  let throwNextPost = false;
  let constructions = 0;
  const factory = (): RecoveryWorker => {
    constructions++;
    if (options.failedConstructions?.includes(constructions)) throw new Error('transient Worker construction failure');
    const construction = constructions;
    const worker: RecoveryWorker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      postMessage(message: unknown) {
        if ((message as PostedCommand).type === 'reset' && options.failedResets?.includes(construction)) throw new Error('Worker reset failed');
        if (throwNextPost) {
          throwNextPost = false;
          throw new Error('injected postMessage failure');
        }
        commands.push(message as PostedCommand);
        const result = handler.handle(message);
        if (!result) return;
        replies.push(result);
        if (deliverNow) worker.onmessage?.({ data: result });
      },
      terminate() { worker.terminated = true; },
    };
    workers.push(worker);
    return worker;
  };
  const source = {
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    close() {},
  };
  const runtime = new TelemetryRuntime({
    url: 'fake',
    fabId: 'fab-a',
    eventSourceFactory: () => source,
    workerFactory: factory,
    workerTimeoutMs: options.workerTimeoutMs ?? 0,
  });
  runtime.start();
  source.onopen?.();
  const send = (sequence: number, state: number) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence,
    payload: { fabId: 'fab-a', sequence, capturedAt: '2026-10-27T00:00:00Z',
      samples: [{ entityId: 'equipment-0', values: { state, utilization: 0.5 } }] },
  }) });
  const sendSamples = (sequence: number, samples: TelemetrySample[]) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence,
    payload: { fabId: 'fab-a', sequence, capturedAt: '2026-10-27T00:00:00Z', samples },
  }) });
  const frames = () => commands.filter((command) => command.type === 'frame');
  const current = () => workers[workers.length - 1];
  const deliver = (index: number) => current().onmessage?.({ data: replies[index] });
  const fail = (kind: 'error' | 'messageerror') => {
    if (kind === 'error') current().onerror?.('worker crashed');
    else current().onmessageerror?.('worker decode failed');
  };
  const throwNextPostMessage = () => { throwNextPost = true; };
  return { runtime, source, workers, commands, replies, frames, current, deliver, fail, send, sendSamples, throwNextPostMessage, constructions: () => constructions };
}

it('retries transient Worker construction failure and preserves sparse pending slots', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ failedConstructions: [2] });
  try {
    h.send(1, 2);
    h.fail('error');
    expect(h.runtime.getToolStates()).toBeUndefined();
    h.sendSamples(2, [{ entityId: 'equipment-1', values: { state: 1 } }]);
    h.sendSamples(3, [{ entityId: 'equipment-2', values: { state: 3 } }]);
    expect(h.constructions()).toBe(2);
    vi.advanceTimersByTime(250);
    expect(h.constructions()).toBe(3);
    expect(h.runtime.getSnapshot()?.sequence).toBe(3);
    expect(h.runtime.getToolStates()?.slice(0, 3)).toEqual(['down', 'idle', 'maint']);
    expect(h.runtime.stale).toBe(false);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it.each(['constructor', 'reset'] as const)('backs off repeated %s faults and cancels recovery on stop', (fault) => {
  vi.useFakeTimers();
  const failures = [2, 3, 4, 5, 6, 7, 8, 9];
  const h = recoveryHarness(fault === 'constructor' ? { failedConstructions: failures } : { failedResets: failures });
  try {
    h.fail('error');
    h.send(1, 2);
    vi.advanceTimersByTime(249);
    expect(h.constructions()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(h.constructions()).toBe(3);
    vi.advanceTimersByTime(499);
    expect(h.constructions()).toBe(3);
    vi.advanceTimersByTime(1);
    expect(h.constructions()).toBe(4);
    const attempts = h.constructions();
    h.runtime.stop();
    vi.advanceTimersByTime(60_000);
    expect(h.constructions()).toBe(attempts);
    expect(h.runtime.status).toBe('stopped');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('recovers even when the initial Worker constructor fails', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ failedConstructions: [1] });
  try {
    h.send(1, 3);
    expect(h.runtime.failed).toBe(true);
    vi.advanceTimersByTime(250);
    expect(h.runtime.getSnapshot()?.sequence).toBe(1);
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
    expect(h.runtime.failed).toBe(false);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('replays a failed postMessage without waiting for another SSE frame', () => {
  vi.useFakeTimers();
  const h = recoveryHarness();
  try {
    h.throwNextPostMessage();
    h.send(1, 2);
    expect(h.runtime.getSnapshot()).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(h.runtime.getSnapshot()?.sequence).toBe(1);
    expect(h.runtime.getToolStates()?.[0]).toBe('down');
    expect(h.constructions()).toBe(2); // the healthy replacement is reused
    expect(vi.getTimerCount()).toBe(0);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('a pending retry never submits a second frame while the replacement is in flight', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ deliverNow: false });
  try {
    h.throwNextPostMessage();
    h.send(1, 2);
    h.send(2, 1); // healthy replacement now has an in-flight frame
    h.send(3, 3); // latest pending frame
    vi.advanceTimersByTime(250);
    expect(h.frames().map(frame => frame.sequence)).toEqual([2]);
    h.deliver(0);
    expect(h.frames().map(frame => frame.sequence)).toEqual([2, 3]);
    h.deliver(1);
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
    expect(vi.getTimerCount()).toBe(0);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('backs off asynchronously failing replacements instead of rebuilding once per error event', () => {
  vi.useFakeTimers();
  const h = recoveryHarness();
  try {
    h.send(1, 0);
    h.fail('error'); // first immediate replacement
    h.fail('error'); // replacement also crashes before producing a valid frame
    h.send(2, 2);
    expect(h.constructions()).toBe(2);
    vi.advanceTimersByTime(249);
    expect(h.constructions()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(h.constructions()).toBe(3);
    expect(h.runtime.getSnapshot()?.sequence).toBe(2);
    expect(h.runtime.getToolStates()?.[0]).toBe('down');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('caps Worker retry delays at eight seconds without making frame bursts create extra attempts', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ failedConstructions: Array.from({ length: 30 }, (_, index) => index + 2) });
  try {
    h.fail('error');
    for (let sequence = 1; sequence <= 100; sequence++) h.send(sequence, 2);
    expect(h.constructions()).toBe(2);
    vi.advanceTimersByTime(15_750); // 250 + 500 + 1000 + 2000 + 4000 + 8000
    expect(h.constructions()).toBe(8);
    vi.advanceTimersByTime(7_999);
    expect(h.constructions()).toBe(8);
    vi.advanceTimersByTime(1);
    expect(h.constructions()).toBe(9);
    vi.advanceTimersByTime(8_000);
    expect(h.constructions()).toBe(10);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('releases the in-flight slot, replays the unanswered frame, then recovers', () => {
  const h = recoveryHarness({ deliverNow: false });
  h.send(1, 2); // in flight, reply withheld
  expect(h.frames()).toHaveLength(1);
  expect(h.runtime.stale).toBe(false);
  h.fail('error');
  // The failed Worker generation is replaced instead of leaving inFlight stuck.
  expect(h.runtime.stale).toBe(true);
  expect(h.runtime.status).toBe('stale');
  expect(h.runtime.failed).toBe(false);
  expect(h.workers).toHaveLength(2);
  expect(h.workers[0].terminated).toBe(true);
  expect(h.workers[1].terminated).toBe(false);
  // The replacement receives the unanswered frame even though no newer SSE frame exists.
  expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1]);
  expect(h.frames()[1].generation).toBeGreaterThan(h.frames()[0].generation ?? 0);
  // The replayed payload is the original frame (equipment-0 state 2), not an empty replay.
  expect(h.frames()[1].values?.[0]).toBe(2);

  h.send(2, 1); // arrives while the replayed frame is in flight: bounded pending
  expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1]);
  h.deliver(0); // reply from the obsolete generation: ignored, slot stays in flight
  expect(h.runtime.getSnapshot()).toBeUndefined();
  expect(h.runtime.stale).toBe(true);
  h.deliver(1); // replay reply: snapshot advances and the pending frame is submitted
  expect(h.runtime.getSnapshot()?.sequence).toBe(1);
  expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1, 2]);
  h.deliver(2);
  expect(h.runtime.getSnapshot()?.sequence).toBe(2);
  expect(h.runtime.getToolStates()?.[0]).toBe('idle');
  expect(h.runtime.stale).toBe(false);
  expect(h.runtime.status).toBe('live');
  h.runtime.stop();
});

it('merges an unanswered frame with newer pending deltas when the Worker is replaced', () => {
  const h = recoveryHarness({ deliverNow: false });
  h.sendSamples(1, [{ entityId: 'equipment-0', values: { state: 2 } }]); // in flight
  h.sendSamples(2, [{ entityId: 'equipment-1', values: { state: 1 } }]); // pending delta
  h.fail('error');
  // One replay frame at the newest sequence: both slots survive and nothing is submitted twice.
  expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 2]);
  const replayed = h.frames()[1].values!;
  expect(replayed[0]).toBe(2); // unanswered frame's equipment-0 update
  expect(replayed[2]).toBe(1); // pending delta's equipment-1 update
  h.deliver(1);
  expect(h.runtime.getSnapshot()?.sequence).toBe(2);
  expect(h.runtime.getToolStates()?.slice(0, 2)).toEqual(['down', 'idle']);
  expect(h.runtime.stale).toBe(false);
  h.runtime.stop();
});

it('releases the slot on messageerror, replays, and recovers through a rebuilt Worker', () => {
  const h = recoveryHarness({ deliverNow: false });
  h.send(1, 0);
  h.fail('messageerror');
  expect(h.runtime.stale).toBe(true);
  expect(h.workers).toHaveLength(2);
  expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1]);
  h.send(2, 2); // pending behind the replay
  h.deliver(1); // replay reply
  expect(h.runtime.getSnapshot()?.sequence).toBe(1);
  h.deliver(2);
  expect(h.runtime.getSnapshot()?.sequence).toBe(2);
  expect(h.runtime.getToolStates()?.[0]).toBe('down');
  expect(h.runtime.stale).toBe(false);
  h.runtime.stop();
});

it('times out a wedged in-flight Worker reply, replays it, and releases the slot', () => {
  vi.useFakeTimers();
  try {
    const h = recoveryHarness({ deliverNow: false, workerTimeoutMs: 50 });
    h.send(1, 0);
    expect(h.frames()).toHaveLength(1);
    vi.advanceTimersByTime(49);
    expect(h.runtime.stale).toBe(false);
    vi.advanceTimersByTime(2);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.status).toBe('stale');
    expect(h.workers).toHaveLength(2);
    // The replacement receives the timed-out frame even though no newer frame exists.
    expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1]);
    h.send(2, 3); // stays bounded behind the replayed frame
    expect(h.frames().map((frame) => frame.sequence)).toEqual([1, 1]);
    h.deliver(1);
    expect(h.runtime.getSnapshot()?.sequence).toBe(1);
    h.deliver(2);
    expect(h.runtime.getSnapshot()?.sequence).toBe(2);
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
    expect(h.runtime.stale).toBe(false);
    h.runtime.stop();
  } finally {
    vi.useRealTimers();
  }
});

it('rolls back the in-flight slot when postMessage throws and converges on the next frame', () => {
  const h = recoveryHarness({ deliverNow: false });
  h.throwNextPostMessage();
  h.send(1, 2); // synchronous postMessage failure
  expect(h.frames()).toHaveLength(0);
  expect(h.runtime.stale).toBe(true);
  expect(h.workers).toHaveLength(2);
  h.send(2, 3); // no in-flight slot: newer frame merges with the held one
  expect(h.frames().map((frame) => frame.sequence)).toEqual([2]);
  h.deliver(0);
  expect(h.runtime.getSnapshot()?.sequence).toBe(2);
  expect(h.runtime.getToolStates()?.[0]).toBe('maint');
  expect(h.runtime.stale).toBe(false);
  h.runtime.stop();
});

it('bounds the pending merge by the registered render slots', () => {
  const known = (index: number, state: number): TelemetrySample =>
    ({ entityId: 'equipment-' + index, values: { state, utilization: 0.5 } });
  const base: TelemetryFrame = {
    fabId: 'fab-a', sequence: 1, capturedAt: '2026-10-27T00:00:00Z', samples: [known(0, 1)],
  };
  const unknown: TelemetrySample[] = Array.from({ length: 1_000 }, (_, index) =>
    ({ entityId: 'external-' + index, values: { state: 2 } }));
  const incoming: TelemetryFrame = {
    fabId: 'fab-a', sequence: 2, capturedAt: '2026-10-27T00:00:01Z',
    samples: [...unknown, known(7, 2), known(7, 0), { entityId: 'equipment-16', values: { state: 2 } }],
  };
  const merged = mergeTelemetryFrames(base, incoming);
  // Unknown/out-of-range ids cannot be rendered and never enter the pending slot.
  expect(merged.samples).toHaveLength(2);
  expect(merged.samples.map((sample) => sample.entityId)).toEqual(['equipment-0', 'equipment-7']);
  expect(merged.samples[1].values.state).toBe(2);

  // Runtime path: 1,000 unknown entities merged during Worker backpressure stay bounded.
  const h = recoveryHarness({ deliverNow: false });
  h.send(1, 2); // in flight: equipment-0 = down
  h.sendSamples(2, unknown);
  h.deliver(0); // flush the single merged pending frame
  expect(h.frames()).toHaveLength(2);
  h.deliver(1);
  expect(h.runtime.getSnapshot()?.sequence).toBe(2);
  expect(h.runtime.getToolStates()?.[0]).toBe('down'); // retained registered slot
  h.runtime.stop();
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
