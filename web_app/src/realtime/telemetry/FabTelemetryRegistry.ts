import type { TelemetryRuntime } from './TelemetryRuntime';

/**
 * FAB-keyed telemetry runtimes: exactly one SSE stream/Worker per fabId. The
 * backend FAB-scoped telemetry endpoint carries its own per-connection frame
 * sequence, so a site-level aggregate runtime would mix FAB identities.
 */
export class FabTelemetryRegistry {
  private readonly runtimes = new Map<string, TelemetryRuntime>();

  replaceAll(next: ReadonlyMap<string, TelemetryRuntime>): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    for (const [fabId, runtime] of next) this.runtimes.set(fabId, runtime);
  }

  get(fabId: string | undefined): TelemetryRuntime | undefined {
    return fabId ? this.runtimes.get(fabId) : undefined;
  }

  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
  }

  get size(): number {
    return this.runtimes.size;
  }

  get fabIds(): readonly string[] {
    return [...this.runtimes.keys()];
  }
}
