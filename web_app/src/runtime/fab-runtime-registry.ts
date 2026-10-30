import type { CommandAdmissionReservation, FabRuntime } from '@/runtime/fab-runtime';

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

  registerAcceptedCommand(siteId: string, fabId: string, commandId: string, reservation: CommandAdmissionReservation): void {
    if (reservation.siteId !== siteId || reservation.fabId !== fabId) throw new Error('reservation identity mismatch');
    const runtime = this.runtimes.get(fabId);
    if (runtime && runtime.siteId !== siteId) throw new Error('runtime identity mismatch');
    if (!runtime) {
      if (reservation.state === 'reserved') reservation.release();
      return;
    }
    // A replaced runtime owns its own lifetime; consume the old reservation and
    // register directly on the current owner without a second admission check.
    if (runtime.ownsReservation(reservation)) {
      reservation.commit(commandId);
    } else {
      runtime.registerAcceptedCommand(commandId);
      if (reservation.state === 'reserved') reservation.release();
    }
  }

  requestAuthoritativeRecovery(siteId: string, fabId: string): void {
    const runtime = this.runtimes.get(fabId);
    if (runtime?.siteId === siteId) runtime.requestAuthoritativeRecovery();
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
