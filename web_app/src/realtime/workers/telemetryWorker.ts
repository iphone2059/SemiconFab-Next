import { createTelemetryWorkerHandler } from './telemetryWorker.logic';

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

// Worker entry. No product code imports this module yet: the real telemetry
// source and COOP/COEP decision (OPEN-V21-14) are still pending. Keeping the
// entry here means the Worker path is ready once the transport lands.
const scope = globalThis as unknown as WorkerScope;
const handler = createTelemetryWorkerHandler({ capacity: 256, frameSize: 8 });
scope.onmessage = (event) => {
  const result = handler.handle(event.data);
  if (result) scope.postMessage(result);
};
