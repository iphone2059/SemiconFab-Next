import type { TelemetryRuntime } from './TelemetryRuntime';

/** Site-keyed telemetry runtimes; one SSE stream/Worker per site. */
export class SiteTelemetryRegistry {
  private readonly runtimes = new Map<string, TelemetryRuntime>();

  replaceAll(next: ReadonlyMap<string, TelemetryRuntime>): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    for (const [siteId, runtime] of next) this.runtimes.set(siteId, runtime);
  }

  get(siteId: string): TelemetryRuntime | undefined {
    return this.runtimes.get(siteId);
  }

  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
  }

  get size(): number {
    return this.runtimes.size;
  }
}
