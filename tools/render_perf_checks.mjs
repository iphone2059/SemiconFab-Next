/** Renderer evidence required in addition to a browser's RAF/canvas support. */
export function isRendererReady(readiness) {
  return readiness?.ready === 'complete' && readiness.canvas === true &&
    readiness.renderer?.status === 'ready' && readiness.renderer.frames > 0 &&
    readiness.renderer.drawCalls > 0 && Array.isArray(readiness.gpuErrors) && readiness.gpuErrors.length === 0;
}

/**
 * Per-profile gate budgets. `dev` preserves the historical 100 ms p95 gate exactly; `60hz`
 * enforces a 60 Hz frame budget plus a bounded JS-heap trend; `custom` starts from the dev
 * budget and only enables the thresholds the caller passes explicitly.
 */
export const RENDER_GATE_PROFILES = Object.freeze({
  dev: Object.freeze({ p95Ms: 100, p99Ms: null, heapGrowthMb: null }),
  '60hz': Object.freeze({ p95Ms: 16.7, p99Ms: 33, heapGrowthMb: 32 }),
  custom: Object.freeze({ p95Ms: 100, p99Ms: null, heapGrowthMb: null }),
});

/** Resolves a partial options object to the effective thresholds of a render gate profile. */
export function resolveRenderGateThresholds(options = {}) {
  const profile = options.profile ?? 'dev';
  const defaults = RENDER_GATE_PROFILES[profile];
  if (!defaults) throw new Error(`Unknown render gate profile: ${profile}`);
  const pick = (value, fallback) => (value === undefined || value === null ? fallback : value);
  return {
    profile,
    p95Ms: pick(options.p95Ms, defaults.p95Ms),
    p99Ms: pick(options.p99Ms, defaults.p99Ms),
    heapGrowthMb: pick(options.heapGrowthMb, defaults.heapGrowthMb),
    readyMs: pick(options.readyMs, null),
    firstFrameMs: pick(options.firstFrameMs, null),
    maxFrames: pick(options.maxFrames, null),
  };
}

/**
 * Gate failures for one render measurement. With no options this is the historical dev gate:
 * p95 must be finite and <= 100 ms, and every pre-existing failure keeps its message and order.
 * Additional profile thresholds are appended before the GPU/browser error check:
 * - p99Ms: the p99 sample must be finite and <= the threshold.
 * - heapGrowthMb: measured JS-heap growth must not exceed the threshold (no evidence is not growth).
 * - readyMs / firstFrameMs (opt-in, off by default): boot timings must be finite and within budget.
 * - maxFrames: caps the frame count required by the renderer/measured-frame sufficiency checks.
 */
export function renderGateFailures(measurement, requestedFrames, options = {}) {
  const thresholds = resolveRenderGateThresholds(options);
  const requiredFrames = Number.isFinite(thresholds.maxFrames) && thresholds.maxFrames > 0
    ? Math.min(requestedFrames, thresholds.maxFrames)
    : requestedFrames;
  const failures = [];
  if (!measurement.secure || !measurement.adapter) failures.push('WebGPU unavailable');
  if (!measurement.canvas || !measurement.rendererReady) failures.push('Renderer is not ready');
  if (!(measurement.drawCalls > 0)) failures.push('No renderer draw calls');
  if (!(measurement.rendererFrames >= Math.floor(requiredFrames * 0.8))) failures.push('Insufficient actual renderer frames');
  if (!(measurement.measuredFrames >= Math.floor(requiredFrames * 0.8))) failures.push('Insufficient measured frames');
  if (!Number.isFinite(measurement.p95FrameMs) || measurement.p95FrameMs > thresholds.p95Ms) {
    failures.push(`Renderer p95 frame time exceeds ${thresholds.p95Ms} ms`);
  }
  if (thresholds.p99Ms !== null) {
    if (!Number.isFinite(measurement.p99FrameMs)) failures.push('Renderer p99 frame time is not finite');
    else if (measurement.p99FrameMs > thresholds.p99Ms) failures.push(`Renderer p99 frame time exceeds ${thresholds.p99Ms} ms`);
  }
  if (thresholds.heapGrowthMb !== null && Number.isFinite(measurement.heapGrowthMb) &&
      measurement.heapGrowthMb > thresholds.heapGrowthMb) {
    failures.push(`Renderer heap growth exceeds ${thresholds.heapGrowthMb} MB`);
  }
  if (thresholds.readyMs !== null &&
      (!Number.isFinite(measurement.readyMs) || measurement.readyMs > thresholds.readyMs)) {
    failures.push(`Renderer ready time exceeds ${thresholds.readyMs} ms`);
  }
  if (thresholds.firstFrameMs !== null &&
      (!Number.isFinite(measurement.firstFrameMs) || measurement.firstFrameMs > thresholds.firstFrameMs)) {
    failures.push(`Renderer first-frame time exceeds ${thresholds.firstFrameMs} ms`);
  }
  if (!Array.isArray(measurement.gpuErrors) || measurement.gpuErrors.length > 0) failures.push('GPU or browser errors');
  return failures;
}
