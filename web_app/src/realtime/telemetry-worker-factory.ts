/**
 * Vite-aware Worker constructor. Keeping the `new Worker(new URL(...))` pattern
 * in a module lets Vite emit the correct worker chunk while tests/tools can
 * import a factory instead of duplicating the bundler-specific URL.
 */
export function createTelemetryWorker(): Worker {
  return new Worker(new URL('./telemetry.worker', import.meta.url), { type: 'module' });
}
