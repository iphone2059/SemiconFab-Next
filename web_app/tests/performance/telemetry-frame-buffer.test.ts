import { expect, it } from 'vitest';
import { FrameRingBuffer } from '@/realtime/frame-ring-buffer';

/**
 * Desktop CPU regression guard for the typed-array high-frequency path. This is
 * not a GPU/WebGPU benchmark and does not replace browser render-loop evidence;
 * it only fails if the pure buffer/worker write path regresses by an order of
 * magnitude (worst observed ~2 ms for this payload on the development machine).
 */
it('sustains 100k typed-array frame writes within a generous CPU budget', () => {
  const frameSize = 8;
  const frames = 100_000;
  const buffer = new FrameRingBuffer({ capacity: 1024, frameSize });
  const frame = Float32Array.from({ length: frameSize }, (_, index) => index * 0.5);
  const started = performance.now();
  for (let index = 0; index < frames; index += 1) buffer.write(frame);
  const elapsedMs = performance.now() - started;
  console.log(`telemetry-frame-buffer: ${frames} writes x ${frameSize} floats in ${elapsedMs.toFixed(2)} ms (${(frames / elapsedMs * 1000).toFixed(0)} frames/s)`);
  expect(buffer.latestSequence).toBe(frames - 1);
  expect([...buffer.readLatest()!]).toEqual([...frame]);
  expect(elapsedMs).toBeLessThan(5_000);
  expect(buffer.droppedFrames).toBe(frames - buffer.capacity);
});
