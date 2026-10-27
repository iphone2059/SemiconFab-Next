import { expect, it } from 'vitest';
import { FrameRingBuffer } from '../src/realtime/buffers/FrameRingBuffer';
import { createTelemetryWorkerHandler } from '../src/realtime/workers/telemetryWorker.logic';

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
  expect(handler.handle({ type: 'frame', sequence: 0, values: [1, 2] })).toEqual({ type: 'frame-written', sequence: 0, dropped: 0 });
  expect(handler.handle({ type: 'frame', sequence: 1, values: [3, 4] })).toEqual({ type: 'frame-written', sequence: 1, dropped: 0 });
  expect(handler.handle({ type: 'frame', sequence: 2, values: [5, 6] })).toEqual({ type: 'frame-written', sequence: 2, dropped: 1 });
  expect(handler.handle({ type: 'snapshot' })).toEqual({ type: 'snapshot', sequence: 2, values: [5, 6] });
  expect(handler.handle({ type: 'frame', sequence: 3, values: [7] })).toBeUndefined();
  expect(handler.handle({ type: 'frame', sequence: 4, values: [Number.NaN] })).toBeUndefined();
  expect(handler.handle({ type: 'reset' })).toBeUndefined();
  expect(handler.buffer.size).toBe(0);
  expect(handler.handle({ type: 'snapshot' })).toBeUndefined();
});
