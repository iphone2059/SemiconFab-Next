import { fabIdentityKey, type FabIdentity } from '@/domain/fab-identity';
import type { TelemetryRuntime } from '@/realtime/telemetry-runtime';

/**
 * Composite-identity keyed telemetry runtimes: exactly one SSE stream/Worker per
 * (siteId, fabId). fabId alone is NOT unique across sites, so every map key is
 * built with fabIdentityKey(); two sites that both have a fabId "fab-01" own two
 * independent runtimes, streams, Worker generations and consumer counts.
 *
 * The backend FAB-scoped telemetry endpoint carries its own per-connection frame
 * sequence, and the frame wire schema has no siteId: isolation comes from the
 * site-scoped URL plus this per-runtime identity (telemetry-runtime.ts), never
 * from inspecting frames.
 *
 * Consumers are reference counted per identity: the first acquire() starts the
 * runtime and the last release stops it. Two components that both use
 * useFabTelemetry(identity) therefore share one stream, and unmounting either one
 * cannot stop it out from under the other. A release closure is bound to the exact
 * identity + runtime instance it acquired: a late cleanup from an old registry
 * generation must never stop the replacement runtime.
 */
export class FabTelemetryRegistry {
  /** Key: fabIdentityKey(runtime). Value: the exact runtime instance. */
  private readonly runtimes = new Map<string, TelemetryRuntime>();
  private readonly listeners = new Set<() => void>();
  /** Mounted-consumer count per identity; a runtime is live only while its count is > 0. */
  private readonly consumers = new Map<string, number>();

  replaceAll(next: readonly TelemetryRuntime[]): void {
    this.stopAll();
    for (const runtime of next) this.runtimes.set(fabIdentityKey(runtime), runtime);
    this.emit();
  }

  /** Registry-generation subscription used by React's external-store hook. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(identity: FabIdentity | undefined): TelemetryRuntime | undefined {
    if (!identity) return undefined;
    return this.runtimes.get(fabIdentityKey(identity));
  }

  /**
   * Register one mounted consumer of a FAB runtime. The first acquire starts the
   * SSE/Worker; concurrent acquires share the same runtime. Returns an idempotent
   * release callback bound to the exact identity + runtime instance: unknown
   * identities get a no-op release, and an old generation's late release can never
   * stop (or otherwise touch) the replacement runtime.
   */
  acquire(identity: FabIdentity | undefined): () => void {
    const runtime = this.get(identity);
    if (!identity || !runtime) return () => {};
    const key = fabIdentityKey(identity);
    const count = (this.consumers.get(key) ?? 0) + 1;
    this.consumers.set(key, count);
    if (count === 1) runtime.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A replaced/disposed registry generation already stopped this runtime;
      // a late cleanup from the old generation must not touch its replacement.
      if (this.runtimes.get(key) !== runtime) return;
      const active = this.consumers.get(key) ?? 0;
      if (active > 1) {
        this.consumers.set(key, active - 1);
        return;
      }
      this.consumers.delete(key);
      runtime.stop();
    };
  }

  disposeAll(): void {
    this.stopAll();
    this.emit();
  }

  get size(): number {
    return this.runtimes.size;
  }

  /** Complete identities of the registered runtimes (exact siteId + fabId). */
  get fabIdentities(): readonly FabIdentity[] {
    return [...this.runtimes.values()].map((runtime) => ({ siteId: runtime.siteId, fabId: runtime.fabId }));
  }

  private stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    this.consumers.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
