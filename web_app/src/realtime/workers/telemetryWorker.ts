import { createTelemetryWorkerHandler } from './telemetryWorker.logic';

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

// Worker entry for the simulated backend telemetry stream (16 samples x 2
// numeric values = 32 floats). The renderer reads the latest states through
// TelemetryRuntime, never through React/Query/Zustand/XState.
const scope = globalThis as unknown as WorkerScope;
const handler = createTelemetryWorkerHandler({ capacity: 256, frameSize: 32 });
scope.onmessage = (event) => {
  const result = handler.handle(event.data);
  if (result) scope.postMessage(result);
};
