import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createTelemetryWorkerHandler } from '../../src/realtime/workers/telemetryWorker.logic';

/**
 * CPU/heap load benchmark for the Worker-side telemetry path at the sizes the
 * review asked about (500 / 2,000 / 5,000 entities). It intentionally tests the
 * pure FrameRingBuffer + worker handler, not GPU/WebGPU; browser frame-time and
 * Worker round-trip stress belongs to tools/render_perf.mjs (real Chrome).
 */
it('sustains 500/2000/5000-entity frames at 60Hz within a generous CPU/heap budget', () => {
  const framesPerSecond = 60;
  const seconds = 5;
  const frameCount = framesPerSecond * seconds;
  const results: Array<{ samples: number; frameSize: number; elapsedMs: number; heapDeltaMb: number }> = [];

  for (const samples of [500, 2000, 5000]) {
    const frameSize = samples * 2;
    const handler = createTelemetryWorkerHandler({ capacity: 256, frameSize });
    const frame = Float32Array.from({ length: frameSize }, (_, index) => (index % 7) * 0.1);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 0; index < frameCount; index += 1) {
      const result = handler.handle({ type: 'frame', sequence: index, values: frame });
      expect(result?.type).toBe('frame-written');
    }
    const elapsedMs = performance.now() - started;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    results.push({ samples, frameSize, elapsedMs, heapDeltaMb });
    // Read back the authoritative latest frame after the burst.
    expect(handler.buffer.latestSequence).toBe(frameCount - 1);
    expect(handler.buffer.readLatest()?.length).toBe(frameSize);
  }

  console.table(results);
  const worst = results.reduce((max, entry) => Math.max(max, entry.elapsedMs), 0);
  expect(worst).toBeLessThan(10_000);
  expect(results.every((entry) => entry.heapDeltaMb < 256)).toBe(true);
});
