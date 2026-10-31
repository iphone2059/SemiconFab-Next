import { Effect, Exit, Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { AppRuntime } from '@/app/app-runtime';
import { DEMO_TICK_MS } from '@/domain/simulation-twin-equipment';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import type { StatusSource } from '@/twin/twin-state';
import { twinUiAtom } from '@/twin/twin-ui.atom';
export interface TwinDemoScheduler {
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(handle: number): void;
}
export const browserTwinDemoScheduler: TwinDemoScheduler = {
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: handle => window.clearInterval(handle),
};
export interface TwinDemoClockOptions {
  readonly appRuntime: AppRuntime<never>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly scheduler: TwinDemoScheduler;
}
export class TwinDemoClockRuntime {
  private readonly scope: Scope.Closeable;
  private handle: number | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: TwinDemoClockOptions) {
    this.scope = options.appRuntime.forkScope();
    options.appRuntime.runSync(Scope.addFinalizer(this.scope, Effect.sync(() => {
      this.stop();
      this.disposed = true;
    })));
  }
  configure(source: StatusSource, playing: boolean): void {
    if (this.disposed) throw new Error('TwinDemoClockRuntime is disposed');
    if (source !== 'demo' || !playing) {
      this.stop();
      return;
    }
    if (this.handle !== null) return;
    const generation = ++this.generation;
    this.handle = this.options.scheduler.setInterval(() => this.tick(generation), DEMO_TICK_MS);
  }
  dispose(): void {
    if (this.disposed) return;
    this.options.appRuntime.runSync(Scope.close(this.scope, Exit.void));
  }
  private stop(): void {
    ++this.generation;
    if (this.handle !== null) this.options.scheduler.clearInterval(this.handle);
    this.handle = null;
  }
  private tick(generation: number): void {
    if (this.disposed || this.generation !== generation) return;
    if (this.options.registry.get(twinUiAtom).statusSource !== 'demo' || !this.options.registry.get(twinDemoAtom).playing) {
      this.stop();
      return;
    }
    twinDemoActions.tick(this.options.registry);
  }
}
