/** Renderer evidence required in addition to a browser's RAF/canvas support. */
export function isRendererReady(readiness) {
  return readiness?.ready === 'complete' && readiness.canvas === true &&
    readiness.renderer?.status === 'ready' && readiness.renderer.frames > 0 &&
    readiness.renderer.drawCalls > 0 && Array.isArray(readiness.gpuErrors) && readiness.gpuErrors.length === 0;
}

export function renderGateFailures(measurement, requestedFrames) {
  const failures = [];
  if (!measurement.secure || !measurement.adapter) failures.push('WebGPU unavailable');
  if (!measurement.canvas || !measurement.rendererReady) failures.push('Renderer is not ready');
  if (!(measurement.drawCalls > 0)) failures.push('No renderer draw calls');
  if (!(measurement.rendererFrames >= Math.floor(requestedFrames * 0.8))) failures.push('Insufficient actual renderer frames');
  if (!(measurement.measuredFrames >= Math.floor(requestedFrames * 0.8))) failures.push('Insufficient measured frames');
  if (!Number.isFinite(measurement.p95FrameMs) || measurement.p95FrameMs > 100) failures.push('Renderer p95 frame time exceeds 100 ms');
  if (!Array.isArray(measurement.gpuErrors) || measurement.gpuErrors.length > 0) failures.push('GPU or browser errors');
  return failures;
}
