import type { TelemetryRuntime } from './TelemetryRuntime';

/**
 * FAB-keyed telemetry runtimes: exactly one SSE stream/Worker per fabId. The
 * backend FAB-scoped telemetry endpoint carries its own per-connection frame
 * sequence, so a site-level aggregate runtime would mix FAB identities.
 *
 * Consumers are reference counted: the first `acquire(fabId)` starts the
 * runtime and the last `release` stops it. Two components that both use
 * `useFabTelemetry(fabId)` therefore share one stream and unmounting either one
 * cannot stop it out from under the other.
 */
export class FabTelemetryRegistry {
  private readonly runtimes = new Map<string, TelemetryRuntime>();
  /** Mounted-consumer count per FAB; a runtime is live only while its count is > 0. */
  private readonly consumers = new Map<string, number>();

  replaceAll(next: ReadonlyMap<string, TelemetryRuntime>): void {
    this.stopAll();
    for (const [fabId, runtime] of next) this.runtimes.set(fabId, runtime);
  }

  get(fabId: string | undefined): TelemetryRuntime | undefined {
    return fabId ? this.runtimes.get(fabId) : undefined;
  }

  /**
   * Register one mounted consumer of a FAB runtime. The first acquire starts
   * the SSE/Worker; concurrent acquires share the same runtime. Returns an
   * idempotent release callback that stops the runtime only after the last
   * consumer releases it. Unknown/disposed FABs return a no-op release.
   */
  acquire(fabId: string | undefined): () => void {
    const runtime = this.get(fabId);
    if (!fabId || !runtime) return () => {};
    const count = (this.consumers.get(fabId) ?? 0) + 1;
    this.consumers.set(fabId, count);
    if (count === 1) runtime.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A replaced/disposed registry generation already stopped this runtime;
      // a late cleanup from the old generation must not touch its replacement.
      if (this.runtimes.get(fabId) !== runtime) return;
      const active = this.consumers.get(fabId) ?? 0;
      if (active > 1) {
        this.consumers.set(fabId, active - 1);
        return;
      }
      this.consumers.delete(fabId);
      runtime.stop();
    };
  }

  disposeAll(): void {
    this.stopAll();
  }

  get size(): number {
    return this.runtimes.size;
  }

  get fabIds(): readonly string[] {
    return [...this.runtimes.keys()];
  }

  private stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    this.consumers.clear();
  }
}
