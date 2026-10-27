import { TELEMETRY_RING_CAPACITY, createTelemetryWorkerHandler } from './telemetryWorker.logic';

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

// Worker entry for the simulated backend telemetry stream (16 samples x 2
// numeric values = 32 floats by default). The renderer reads the latest states
// through TelemetryRuntime, never through React/Query/Zustand/XState.
// A dev-only stress page may send an 'init' frameSize to exercise larger frames.
// Only readLatest() is consumed, so the ring stays shallow (8 frames): it still
// absorbs a burst after a worker stall while keeping the 5,000-entity stress
// buffer at ~0.3 MB instead of the ~10 MB a 256-frame history would allocate.
const scope = globalThis as unknown as WorkerScope;
const createHandler = (frameSize: number) => createTelemetryWorkerHandler({ capacity: TELEMETRY_RING_CAPACITY, frameSize });
let handler = createHandler(32);
scope.onmessage = (event) => {
  const data = event.data as { type?: unknown; frameSize?: unknown } | undefined;
  if (data?.type === 'init' && Number.isInteger(data.frameSize) && Number(data.frameSize) > 0 && Number(data.frameSize) <= 20000) {
    handler = createHandler(Number(data.frameSize));
    scope.postMessage({ type: 'initialized', frameSize: Number(data.frameSize) });
    return;
  }
  const result = handler.handle(data);
  if (result) scope.postMessage(result);
};
