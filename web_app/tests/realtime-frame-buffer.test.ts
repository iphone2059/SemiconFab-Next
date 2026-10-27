import { expect, it } from 'vitest';
import { FrameRingBuffer } from '../src/realtime/buffers/FrameRingBuffer';
import type { TelemetryWorkerEvent } from '../src/realtime/workers/telemetryWorker.logic';
import { TELEMETRY_RING_CAPACITY, createTelemetryWorkerHandler } from '../src/realtime/workers/telemetryWorker.logic';

type FrameWrittenEvent = Extract<TelemetryWorkerEvent, { type: 'frame-written' }>;
type SnapshotEvent = Extract<TelemetryWorkerEvent, { type: 'snapshot' }>;

function expectFrameWritten(
  result: TelemetryWorkerEvent | undefined,
  expected: { sequence: number; dropped: number; latest: number[] },
): FrameWrittenEvent {
  expect(result?.type).toBe('frame-written');
  const event = result as FrameWrittenEvent;
  expect(event.sequence).toBe(expected.sequence);
  expect(event.dropped).toBe(expected.dropped);
  expect(event.latest).toBeInstanceOf(Float32Array);
  expect([...event.latest]).toEqual(expected.latest);
  return event;
}

function expectSnapshot(result: TelemetryWorkerEvent | undefined, expected: { sequence: number; values: number[] }): SnapshotEvent {
  expect(result?.type).toBe('snapshot');
  const event = result as SnapshotEvent;
  expect(event.sequence).toBe(expected.sequence);
  expect(event.values).toBeInstanceOf(Float32Array);
  expect([...event.values]).toEqual(expected.values);
  return event;
}

it('writes/reads typed frames and reports overflow drops', () => {
  const buffer = new FrameRingBuffer({ capacity: 3, frameSize: 2 });
  expect(buffer.readLatest()).toBeUndefined();
  expect(buffer.write([1, 2])).toBe(0);
  expect(buffer.write([3, 4])).toBe(1);
  expect(buffer.write([5, 6])).toBe(2);
  expect([...buffer.readLatest()!]).toEqual([5, 6]);
  expect(buffer.write([7, 8])).toBe(3);
  expect(buffer.size).toBe(3);
  expect(buffer.droppedFrames).toBe(1);
  expect([...buffer.read(1)!]).toEqual([3, 4]);
  expect(buffer.read(0)).toBeUndefined();
  expect([...buffer.read(3)!]).toEqual([7, 8]);
  expect(buffer.readLatest(new Float32Array(2))).toEqual(Float32Array.from([7, 8]));
});

it('rejects malformed frames and invalid targets', () => {
  const buffer = new FrameRingBuffer({ frameSize: 2 });
  expect(() => new FrameRingBuffer({ frameSize: 0 })).toThrow(/frameSize/);
  expect(() => new FrameRingBuffer({ capacity: 0, frameSize: 2 })).toThrow(/capacity/);
  expect(() => buffer.write([1])).toThrow(/expected 2/);
  buffer.write([1, 2]);
  expect(() => buffer.readLatest(new Float32Array(3))).toThrow(/target/);
});

it('handles worker commands without touching application state', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 2 });
  expectFrameWritten(handler.handle({ type: 'frame', sequence: 0, values: [1, 2] }), { sequence: 0, dropped: 0, latest: [1, 2] });
  expectFrameWritten(handler.handle({ type: 'frame', sequence: 1, values: [3, 4] }), { sequence: 1, dropped: 0, latest: [3, 4] });
  expectFrameWritten(handler.handle({ type: 'frame', sequence: 2, values: [5, 6] }), { sequence: 2, dropped: 1, latest: [5, 6] });
  expectSnapshot(handler.handle({ type: 'snapshot' }), { sequence: 2, values: [5, 6] });
  expect(handler.handle({ type: 'frame', sequence: 3, values: [7] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 4, values: [Number.NaN] })).toBeUndefined();
  expect(handler.handle({ type: 'reset' })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
  expect(handler.handle({ type: 'snapshot' })).toBeUndefined();
});

it('replies with typed arrays that do not alias the ring storage', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 2 });
  const written = expectFrameWritten(handler.handle({ type: 'frame', sequence: 0, values: [1, 2] }), { sequence: 0, dropped: 0, latest: [1, 2] });
  // The runtime keeps the reply array; mutating it must not corrupt the ring.
  written.latest[0] = 99;
  expect([...handler.buffer.readLatest()!]).toEqual([1, 2]);
  expectSnapshot(handler.handle({ type: 'snapshot' }), { sequence: 0, values: [1, 2] });
});

it('accepts Float32Array frames and writes them into the buffer', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 3 });
  const frame = Float32Array.from([1.5, -2, 3.25]);
  const written = expectFrameWritten(handler.handle({ type: 'frame', sequence: 0, values: frame }), { sequence: 0, dropped: 0, latest: [1.5, -2, 3.25] });
  expect(written.latest).not.toBe(frame);
  expect([...handler.buffer.readLatest()!]).toEqual([1.5, -2, 3.25]);
});

it('rejects NaN and infinite frame values', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 2 });
  expect(handler.handle({ type: 'frame', sequence: 0, values: [1, Number.NaN] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 1, values: [Number.POSITIVE_INFINITY, 1] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 2, values: [1, Number.NEGATIVE_INFINITY] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 3, values: Float32Array.from([Number.NaN, 1]) })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
});

it('rejects frames with non-number entries', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 2 });
  expect(handler.handle({ type: 'frame', sequence: 0, values: ['1', 2] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 1, values: [1, undefined] })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
});

it('rejects sparse frames whose holes are not numbers', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 2 });
  const sparse: number[] = new Array(2);
  expect(handler.handle({ type: 'frame', sequence: 0, values: sparse })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
});

it('accepts a production-size 32-value frame', () => {
  const handler = createTelemetryWorkerHandler({ frameSize: 32 });
  const values = Array.from({ length: 32 }, (_, index) => index / 2);
  expectFrameWritten(handler.handle({ type: 'frame', sequence: 0, values }), { sequence: 0, dropped: 0, latest: values });
  expect([...handler.buffer.readLatest()!]).toEqual(values);
});

it('still rejects frames whose length does not match frameSize', () => {
  const handler = createTelemetryWorkerHandler({ capacity: 2, frameSize: 3 });
  expect(handler.handle({ type: 'frame', sequence: 0, values: [1, 2] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 0, values: [1, 2, 3, 4] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 0, values: Float32Array.from([1, 2]) })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
});

it('keeps the product ring shallow because only readLatest() is consumed', () => {
  // 5,000 entities = 10,000 floats per frame. The old 256-frame default ring
  // allocated ~10 MB; the shallow product ring keeps this under 1 MB (~0.3 MB).
  const handler = createTelemetryWorkerHandler({ frameSize: 10_000 });
  expect(handler.buffer.capacity).toBe(TELEMETRY_RING_CAPACITY);
  const bytes = handler.buffer.capacity * handler.buffer.frameSize * Float32Array.BYTES_PER_ELEMENT;
  expect(bytes).toBeLessThan(1024 * 1024);
});

it('reports truthful overflow drops for the shallow default ring', () => {
  const handler = createTelemetryWorkerHandler();
  expect(handler.buffer.capacity).toBe(TELEMETRY_RING_CAPACITY);
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let sequence = 0; sequence < TELEMETRY_RING_CAPACITY; sequence += 1) {
    expectFrameWritten(handler.handle({ type: 'frame', sequence, values }), { sequence, dropped: 0, latest: values });
  }
  expectFrameWritten(
    handler.handle({ type: 'frame', sequence: TELEMETRY_RING_CAPACITY, values }),
    { sequence: TELEMETRY_RING_CAPACITY, dropped: 1, latest: values },
  );
});
