import { createTelemetryWorker } from '../src/realtime/workers/createTelemetryWorker';

interface StressCase {
  readonly entities: number;
  readonly seconds: number;
  readonly rate: number;
}

declare global {
  interface Window {
    __TELEMETRY_STRESS__?: unknown;
  }
}

const params = new URLSearchParams(location.search);
const seconds = Number(params.get('seconds') ?? '5');
const rate = Number(params.get('rate') ?? '60');
const entitySizes = (params.get('entities') ?? '500,2000,5000')
  .split(',')
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function runCase({ entities, seconds: duration, rate: hz }: StressCase) {
  const frameSize = entities * 2;
  const worker = createTelemetryWorker();
  const latencies: number[] = [];
  const pendingSends = new Map<number, number>();
  let received = 0;
  const errors: string[] = [];
  worker.onerror = (event) => errors.push(String((event as ErrorEvent).message || 'worker error'));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker init timeout')), 5000);
    worker.onmessage = (event) => {
      const data = event.data as { type?: string; frameSize?: number; sequence?: number };
      if (data?.type === 'initialized') { clearTimeout(timer); resolve(); return; }
      if (data?.type === 'frame-written') {
        received += 1;
        const started = pendingSends.get(Number(data.sequence));
        if (typeof started === 'number') { latencies.push(performance.now() - started); pendingSends.delete(Number(data.sequence)); }
      }
    };
    worker.postMessage({ type: 'init', frameSize });
  });

  const values = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) values[index] = (index % 7) * 0.1;
  const expected = Math.max(1, Math.round(duration * hz));
  const intervalMs = 1000 / hz;
  let sequence = 0;
  let maxSendDelayMs = 0;
  let lastTick = performance.now();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = performance.now();
      maxSendDelayMs = Math.max(maxSendDelayMs, now - lastTick - intervalMs);
      lastTick = now;
      pendingSends.set(sequence, now);
      worker.postMessage({ type: 'frame', sequence, values });
      sequence += 1;
      if (sequence >= expected) {
        clearInterval(timer);
        setTimeout(resolve, Math.max(300, intervalMs * 8));
      }
    }, intervalMs);
  });
  worker.terminate();
  const sorted = latencies.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return {
    entities,
    frameSize,
    expected,
    sent: sequence,
    received,
    receiveRatio: Number((received / Math.max(1, expected)).toFixed(3)),
    averageLatencyMs: Number((sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)).toFixed(2)),
    p95LatencyMs: Number(percentile(sorted, 0.95).toFixed(2)),
    maxLatencyMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    maxSendDelayMs: Number(maxSendDelayMs.toFixed(2)),
    errors,
  };
}

(async () => {
  try {
    const results: Awaited<ReturnType<typeof runCase>>[] = [];
    for (const entities of entitySizes) results.push(await runCase({ entities, seconds, rate }));
    const report = {
      measuredAt: new Date().toISOString(),
      href: location.href,
      userAgent: navigator.userAgent,
      seconds,
      rate,
      results,
    };
    window.__TELEMETRY_STRESS__ = report;
    const output = document.getElementById('result');
    if (output) output.textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    window.__TELEMETRY_STRESS__ = { error: error instanceof Error ? error.message : String(error) };
  }
})();
