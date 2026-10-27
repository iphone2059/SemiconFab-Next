import { createTelemetryWorkerHandler } from './telemetryWorker.logic';

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

// Worker entry for the simulated backend telemetry stream (16 samples x 2
// numeric values = 32 floats by default). The renderer reads the latest states
// through TelemetryRuntime, never through React/Query/Zustand/XState.
// A dev-only stress page may send an 'init' frameSize to exercise larger frames.
const scope = globalThis as unknown as WorkerScope;
let handler = createTelemetryWorkerHandler({ capacity: 256, frameSize: 32 });
scope.onmessage = (event) => {
  const data = event.data as { type?: unknown; frameSize?: unknown } | undefined;
  if (data?.type === 'init' && Number.isInteger(data.frameSize) && Number(data.frameSize) > 0 && Number(data.frameSize) <= 20000) {
    handler = createTelemetryWorkerHandler({ capacity: 256, frameSize: Number(data.frameSize) });
    scope.postMessage({ type: 'initialized', frameSize: Number(data.frameSize) });
    return;
  }
  const result = handler.handle(data);
  if (result) scope.postMessage(result);
};
