import { expect, it, vi } from 'vitest';
import type { TelemetryFrame, TelemetrySample } from '@/contracts/command-events.contract';
import type { TelemetryWorkerEvent } from '@/realtime/telemetry-worker.logic';
import { TelemetryRuntime, mergeTelemetryFrames } from '@/realtime/telemetry-runtime';
import { createTelemetryWorkerHandler } from '@/realtime/telemetry-worker.logic';

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
  const runtime = new TelemetryRuntime({ siteId: 'site-1', fabId: 'fab-a', url: 'fake', eventSourceFactory: () => source, workerFactory: () => worker });
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
  expect(runtime.siteId).toBe('site-1');
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
function recoveryHarness(options: { deliverNow?: boolean; workerTimeoutMs?: number; frameTimeoutMs?: number; open?: boolean; failedConstructions?: readonly number[]; failedResets?: readonly number[] } = {}) {
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
    onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    close: vi.fn(),
  };
  const runtime = new TelemetryRuntime({
    siteId: 'site-1',
    fabId: 'fab-a',
    url: 'fake',
    eventSourceFactory: () => source,
    workerFactory: factory,
    workerTimeoutMs: options.workerTimeoutMs ?? 0,
    frameTimeoutMs: options.frameTimeoutMs ?? 0,
  });
  runtime.start();
  if (options.open !== false) source.onopen?.();
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

it('marks a disconnected SSE stream stale immediately and recovers on a newer same-stream frame', () => {
  const h = recoveryHarness();
  try {
    h.send(10, 2);
    const previous = h.runtime.getSnapshot();
    expect(h.runtime.status).toBe('live');
    h.source.onerror?.();
    expect(h.runtime.status).toBe('stale');
    expect(h.runtime.getSnapshot()).toBe(previous); // diagnostics retain the last frame
    expect(h.runtime.getToolStates()).toBeUndefined(); // renderer falls back instead
    expect(h.constructions()).toBe(1); // SSE faults do not churn healthy Workers
    h.send(10, 0); // duplicate from the lost stream is not recovery
    expect(h.runtime.stale).toBe(true);
    h.send(11, 1);
    expect(h.runtime.status).toBe('live');
    expect(h.runtime.getToolStates()?.[0]).toBe('idle');
  } finally { h.runtime.stop(); }
});

it('invalidates pre-error Worker replies and pending frames before same-stream recovery', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ deliverNow: false, workerTimeoutMs: 100, frameTimeoutMs: 50 });
  try {
    h.send(1, 2);
    h.send(2, 0); // pending behind an unanswered Worker reply
    h.source.onerror?.();
    expect(vi.getTimerCount()).toBe(0);
    h.deliver(0);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getSnapshot()).toBeUndefined();
    expect(h.frames().map(frame => frame.sequence)).toEqual([1]);
    h.send(3, 3); // no onopen: increasing sequences still recover on this source
    expect(h.frames().map(frame => frame.sequence)).toEqual([1, 3]);
    expect(h.frames()[1].generation).toBeGreaterThan(h.frames()[0].generation!);
    expect(h.runtime.stale).toBe(true); // receipt alone is not a healthy Worker reply
    h.deliver(0); // old generation cannot release the new in-flight slot
    expect(h.runtime.stale).toBe(true);
    h.deliver(1);
    expect(h.runtime.status).toBe('live');
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('waits for a current-generation valid Worker frame after SSE reconnect resets the wire sequence', () => {
  const h = recoveryHarness({ deliverNow: false });
  try {
    h.send(100, 2);
    h.source.onerror?.();
    h.source.onopen?.();
    expect(h.runtime.status).toBe('idle');
    expect(h.runtime.getToolStates()).toBeUndefined();
    h.deliver(0);
    expect(h.runtime.getSnapshot()).toBeUndefined();
    h.send(1, 3);
    expect(h.runtime.status).not.toBe('live');
    h.deliver(1);
    expect(h.runtime.getSnapshot()?.sequence).toBe(1);
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
    expect(h.runtime.status).toBe('live');
  } finally { h.runtime.stop(); }
});

it('bounds the initial no-open/no-frame wait and starts a fresh watchdog on open', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ open: false, frameTimeoutMs: 50 });
  try {
    expect(h.runtime.status).toBe('idle');
    vi.advanceTimersByTime(50);
    expect(h.runtime.stale).toBe(true);
    h.source.onopen?.();
    expect(h.runtime.status).toBe('idle');
    vi.advanceTimersByTime(49);
    expect(h.runtime.status).toBe('idle');
    vi.advanceTimersByTime(1);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getToolStates()).toBeUndefined();
    h.send(1, 1);
    expect(h.runtime.status).toBe('live');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('uses a generous production watchdog and falls back when live frames silently stop', () => {
  vi.useFakeTimers();
  const h = harness(); // production default, not the disabled recovery-harness timer
  try {
    h.send(1, 2);
    const previous = h.runtime.getSnapshot();
    vi.advanceTimersByTime(14_999);
    expect(h.runtime.status).toBe('live');
    vi.advanceTimersByTime(1);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getSnapshot()).toBe(previous);
    expect(h.runtime.getToolStates()).toBeUndefined();
    h.send(2, 3);
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
    expect(h.runtime.status).toBe('live');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('refreshes the watchdog only when a newer valid frame arrives, not when its Worker replies', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ deliverNow: false, frameTimeoutMs: 50 });
  try {
    h.send(1, 2);
    vi.advanceTimersByTime(30);
    h.send(2, 1); // valid pending frame extends the stream deadline to t=80
    vi.advanceTimersByTime(19);
    h.deliver(0); // t=49; applies frame 1 and flushes pending frame 2
    vi.advanceTimersByTime(30);
    h.deliver(1); // t=79; Worker health does not extend the stream deadline
    expect(h.runtime.status).toBe('live');
    vi.advanceTimersByTime(1);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getToolStates()).toBeUndefined();
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

const invalidLivenessMessages = [
  ['malformed JSON', '{'],
  ['invalid payload', JSON.stringify({ topic: 'telemetry.frame', payload: { fabId: 'fab-a', sequence: 11 } })],
  ['wrong FAB', JSON.stringify({ topic: 'telemetry.frame', payload: {
    fabId: 'fab-b', sequence: 11, capturedAt: 'now', samples: [],
  } })],
  ['duplicate sequence', JSON.stringify({ topic: 'telemetry.frame', payload: {
    fabId: 'fab-a', sequence: 10, capturedAt: 'now', samples: [],
  } })],
  ['older sequence', JSON.stringify({ topic: 'telemetry.frame', payload: {
    fabId: 'fab-a', sequence: 9, capturedAt: 'now', samples: [],
  } })],
  ['another topic', JSON.stringify({ topic: 'alarm.event', payload: {
    fabId: 'fab-a', alarmId: 'alarm-1', severity: 'warning', message: 'warning', occurredAt: 'now',
  } })],
] as const;

it.each(invalidLivenessMessages)('does not extend or restore SSE liveness for %s', (_label, data) => {
  vi.useFakeTimers();
  const h = recoveryHarness({ frameTimeoutMs: 50 });
  try {
    h.send(10, 2);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(10);
      h.source.onmessage?.({ data });
    }
    expect(h.runtime.status).toBe('live');
    vi.advanceTimersByTime(10);
    expect(h.runtime.stale).toBe(true);
    h.source.onmessage?.({ data });
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getToolStates()).toBeUndefined();
    h.send(11, 3);
    expect(h.runtime.status).toBe('live');
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('drops late pre-timeout Worker replies and recovers only after a fresh valid frame applies', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ deliverNow: false, frameTimeoutMs: 50, workerTimeoutMs: 100 });
  try {
    h.send(1, 2);
    vi.advanceTimersByTime(50);
    expect(h.runtime.stale).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // old Worker timeout was released too
    h.deliver(0);
    expect(h.runtime.stale).toBe(true);
    expect(h.runtime.getSnapshot()).toBeUndefined();
    h.send(2, 1);
    expect(h.runtime.stale).toBe(true);
    h.deliver(1);
    expect(h.runtime.status).toBe('live');
    expect(h.runtime.getToolStates()?.[0]).toBe('idle');
    expect(h.constructions()).toBe(1);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it.each([undefined, [], [Number.NaN], Array(32).fill(Number.POSITIVE_INFINITY)].map(latest => ({ latest })))(
  'does not recover from SSE loss using an invalid Worker payload ($latest)', ({ latest }) => {
    const h = recoveryHarness({ deliverNow: false });
    try {
      h.send(1, 2);
      h.source.onerror?.();
      h.send(2, 3);
      const frame = h.frames()[1];
      h.current().onmessage?.({ data: { type: 'frame-written', sequence: 2, generation: frame.generation, latest } });
      expect(h.runtime.stale).toBe(true);
      expect(h.runtime.getToolStates()).toBeUndefined();
      h.deliver(1);
      expect(h.runtime.status).toBe('live');
    } finally { h.runtime.stop(); }
  },
);

it('does not replay expired pending data when Worker allocation recovers after the SSE deadline', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ deliverNow: false, frameTimeoutMs: 50, failedConstructions: [2] });
  try {
    h.send(1, 2);
    h.fail('error'); // pending replay waits for a Worker allocation retry at t=250
    expect(h.runtime.failed).toBe(true);
    vi.advanceTimersByTime(50);
    expect(h.runtime.stale).toBe(true);
    vi.advanceTimersByTime(200);
    expect(h.constructions()).toBe(3);
    expect(h.runtime.failed).toBe(false);
    expect(h.frames().map(frame => frame.sequence)).toEqual([1]);
    expect(h.runtime.stale).toBe(true);
    h.send(2, 3);
    expect(h.runtime.stale).toBe(true);
    h.deliver(1);
    expect(h.runtime.status).toBe('live');
    expect(h.runtime.getToolStates()?.[0]).toBe('maint');
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

it('replaces rather than accumulates watchdogs on reopen and detaches/clears everything on stop', () => {
  vi.useFakeTimers();
  const h = recoveryHarness({ frameTimeoutMs: 50, workerTimeoutMs: 100 });
  try {
    h.send(1, 2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30);
    h.source.onopen?.();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(20); // original deadline; reset timer must not fire
    expect(h.runtime.status).toBe('idle');
    const lateError = h.source.onerror;
    const lateOpen = h.source.onopen;
    const lateMessage = h.source.onmessage;
    h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.source.onerror).toBeNull();
    expect(h.source.onopen).toBeNull();
    expect(h.source.onmessage).toBeNull();
    expect(h.source.close).toHaveBeenCalledOnce();
    lateError?.();
    lateOpen?.();
    lateMessage?.({ data: JSON.stringify({ topic: 'telemetry.frame', payload: {
      fabId: 'fab-a', sequence: 2, capturedAt: 'now', samples: [],
    } }) });
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.runtime.status).toBe('stopped');
    expect(h.runtime.getToolStates()).toBeUndefined();
    expect(h.constructions()).toBe(1);
  } finally { h.runtime.stop(); vi.useRealTimers(); }
});

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
  const { runtime, worker, send } = harness(true);
  send(1, 2);
  // The harness opens the SSE source once during setup, so the active Worker
  // generation is 1 (setup reset) before any frame is submitted.
  const generation = 1;
  const view = Float64Array.from({ length: 32 }, (_, index) => (index === 0 ? 2 : 0));
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 1, latest: view, generation } });
  expect(runtime.getSnapshot()?.values).toBeInstanceOf(Float32Array);
  expect(runtime.getToolStates()?.[0]).toBe('down');
  send(2, 1);
  const legacy = Array.from({ length: 32 }, (_, index) => (index === 0 ? 1 : 0));
  worker.onmessage?.({ data: { type: 'frame-written', sequence: 2, latest: legacy, generation } });
  expect(runtime.getSnapshot()?.sequence).toBe(2);
  expect(runtime.getToolStates()?.[0]).toBe('idle');
  runtime.stop();
});

/**
 * R5.4-03: one runtime per exact (siteId, fabId). The harness proves the runtime
 * exposes its identity, requests only the composition-root URL and never lets two
 * same-fabId runtimes of different sites share state.
 */
function identityHarness(siteId: string, fabId: string, url: string) {
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const requestedUrls: string[] = [];
  const source = {
    onopen: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    close: vi.fn(),
  };
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown) {
      const result = handler.handle(message);
      if (result) this.onmessage?.({ data: result });
    },
    terminate() {},
  };
  const runtime = new TelemetryRuntime({
    siteId,
    fabId,
    url,
    eventSourceFactory: (target) => { requestedUrls.push(target); return source; },
    workerFactory: () => worker,
  });
  const send = (sequence: number, state: number, frameFabId = fabId) => source.onmessage?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence,
    payload: {
      fabId: frameFabId, sequence, capturedAt: '2026-10-27T00:00:00Z',
      samples: [{ entityId: 'equipment-0', values: { state, utilization: 0.5 } }],
    },
  }) });
  const start = () => { runtime.start(); source.onopen?.(); };
  return { runtime, source, requestedUrls, send, start };
}

it('R5.4-03 T05/T12: same-fabId runtimes of different sites request their own URL and stay independent', () => {
  const siteA = identityHarness('site-a', 'fab-01', '/api/v1/sites/site-a/fabs/fab-01/telemetry/stream');
  const siteB = identityHarness('site-b', 'fab-01', '/api/v1/sites/site-b/fabs/fab-01/telemetry/stream');
  expect(siteA.runtime.siteId).toBe('site-a');
  expect(siteA.runtime.fabId).toBe('fab-01');
  expect(siteB.runtime.siteId).toBe('site-b');
  expect(siteB.runtime.fabId).toBe('fab-01');

  siteA.start();
  siteB.start();
  // The URL is supplied by the composition root; the runtime never derives it and
  // never repairs it from a bare fabId.
  expect(siteA.requestedUrls).toEqual(['/api/v1/sites/site-a/fabs/fab-01/telemetry/stream']);
  expect(siteB.requestedUrls).toEqual(['/api/v1/sites/site-b/fabs/fab-01/telemetry/stream']);

  siteA.send(1, 2);
  siteB.send(1, 1);
  expect(siteA.runtime.getToolStates()?.[0]).toBe('down');
  expect(siteB.runtime.getToolStates()?.[0]).toBe('idle');

  // The Site A stream's newer frame never changes the Site B runtime.
  siteA.send(2, 3);
  expect(siteA.runtime.getToolStates()?.[0]).toBe('maint');
  expect(siteB.runtime.getSnapshot()?.sequence).toBe(1);
  expect(siteB.runtime.getToolStates()?.[0]).toBe('idle');

  siteB.runtime.stop();
  expect(siteB.runtime.getSnapshot()).toBeUndefined();
  expect(siteA.runtime.getToolStates()?.[0]).toBe('maint');
  siteA.runtime.stop();
});

it('R5.4-03 T11: a late event from the old site generation cannot modify the replacement telemetry runtime', () => {
  const old = identityHarness('site-a', 'fab-01', '/api/v1/sites/site-a/fabs/fab-01/telemetry/stream');
  old.start();
  old.send(1, 2);
  expect(old.runtime.getToolStates()?.[0]).toBe('down');
  // Capture the live SSE handler before the old generation is stopped: it models a
  // browser that has already queued an event from the closed site-a connection.
  const lateOldHandler = old.source.onmessage;
  old.runtime.stop();

  const next = identityHarness('site-b', 'fab-01', '/api/v1/sites/site-b/fabs/fab-01/telemetry/stream');
  next.start();
  // The wire frame carries only fabId (schema unchanged); the same fabId exists in
  // site-b, so only the stopped generation's guards may reject this late frame.
  lateOldHandler?.({ data: JSON.stringify({
    topic: 'telemetry.frame', sequence: 9,
    payload: {
      fabId: 'fab-01', sequence: 9, capturedAt: '2026-10-27T00:00:00Z',
      samples: [{ entityId: 'equipment-0', values: { state: 2, utilization: 0.5 } }],
    },
  }) });
  expect(old.runtime.getSnapshot()).toBeUndefined();
  expect(next.runtime.getSnapshot()).toBeUndefined();
  expect(next.runtime.getToolStates()).toBeUndefined();

  // The replacement generation applies only its own frames.
  next.send(1, 1);
  expect(next.runtime.getSnapshot()?.sequence).toBe(1);
  expect(next.runtime.getToolStates()?.[0]).toBe('idle');
  next.runtime.stop();
});
