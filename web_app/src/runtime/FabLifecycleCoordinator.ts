import type { FabRuntimeRegistry } from './FabRuntimeRegistry';

/**
 * Owns start/stop/dispose ordering for a set of FAB runtimes. StrictMode-safe:
 * repeated start/stop calls are idempotent, and dispose clears every runtime.
 */
export class FabLifecycleCoordinator {
  private started = false;

  constructor(private readonly registry: FabRuntimeRegistry) {}

  start(): void {
    if (this.started) return;
    this.registry.startAll();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.registry.stopAll();
    this.started = false;
  }

  dispose(): void {
    this.stop();
    this.registry.disposeAll();
  }

  get running(): boolean {
    return this.started;
  }
}
