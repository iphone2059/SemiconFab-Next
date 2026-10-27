import type { FabRuntime } from './FabRuntime';

/** FAB-keyed runtime registry; one entry per fabId, no shared mutable runtime. */
export class FabRuntimeRegistry {
  private readonly runtimes = new Map<string, FabRuntime>();

  register(runtime: FabRuntime): void {
    if (this.runtimes.has(runtime.fabId)) throw new Error(`FAB runtime already registered: ${runtime.fabId}`);
    this.runtimes.set(runtime.fabId, runtime);
  }

  get(fabId: string): FabRuntime | undefined {
    return this.runtimes.get(fabId);
  }

  remove(fabId: string): FabRuntime | undefined {
    const runtime = this.runtimes.get(fabId);
    if (!runtime) return undefined;
    runtime.dispose();
    this.runtimes.delete(fabId);
    return runtime;
  }

  startAll(): void {
    for (const runtime of this.runtimes.values()) runtime.start();
  }

  stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
  }

  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  get size(): number {
    return this.runtimes.size;
  }

  get fabIds(): readonly string[] {
    return [...this.runtimes.keys()];
  }
}
