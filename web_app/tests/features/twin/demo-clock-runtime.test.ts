import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterEach, expect, it } from 'vitest';
import { DEMO_TICK_MS } from '@/domain/simulation-twin-equipment';
import { twinDemoActions, twinDemoAtom } from '@/twin/twin-demo.atom';
import { TwinDemoClockRuntime, type TwinDemoScheduler } from '@/twin/twin-demo-clock-runtime';
import { createTwinUiState } from '@/twin/twin-state';
import { twinUiActions, twinUiAtom } from '@/twin/twin-ui.atom';
import { createTestRuntime } from '../../support/resource-test-runtime.tsx';
class VirtualDemoIntervals implements TwinDemoScheduler {
  private nextHandle = 0;
  private readonly jobs = new Map<number, () => void>();
  setInterval(callback: () => void, delayMs: number): number {
    expect(delayMs).toBe(DEMO_TICK_MS);
    const handle = ++this.nextHandle;
    this.jobs.set(handle, callback);
    return handle;
  }
  clearInterval(handle: number): void {
    this.jobs.delete(handle);
  }
  get pendingCount(): number {
    return this.jobs.size;
  }
  callbacks(): Array<() => void> {
    return [...this.jobs.values()];
  }
  fire(): void {
    for (const callback of this.callbacks()) callback();
  }
}
const disposals = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const dispose of disposals) await dispose();
  disposals.clear();
});
function create() {
  const registry = AtomRegistry.make();
  registry.set(twinUiAtom, createTwinUiState());
  const appRuntime = createTestRuntime(registry);
  const scheduler = new VirtualDemoIntervals();
  const runtime = new TwinDemoClockRuntime({ appRuntime, registry, scheduler });
  disposals.add(async () => { runtime.dispose(); await appRuntime.dispose(); });
  return { registry, scheduler, runtime };
}
it('owns one 1600ms interval while DEMO is the active playing source', () => {
  const { registry, scheduler, runtime } = create();
  const start = registry.get(twinDemoAtom).cycle;
  runtime.configure('demo', true);
  runtime.configure('demo', true);
  expect(scheduler.pendingCount).toBe(1);
  scheduler.fire();
  expect(registry.get(twinDemoAtom).cycle).toBe(start + 1);
  runtime.configure('sse-live', true);
  expect(scheduler.pendingCount).toBe(0);
});
it('cancels on pause, rejects stale callbacks, then resumes with one new interval', () => {
  const { registry, scheduler, runtime } = create();
  runtime.configure('demo', true);
  const stale = scheduler.callbacks()[0];
  twinDemoActions.playingSet(registry, false);
  runtime.configure('demo', false);
  const paused = registry.get(twinDemoAtom).cycle;
  stale();
  expect(registry.get(twinDemoAtom).cycle).toBe(paused);
  twinDemoActions.playingSet(registry, true);
  runtime.configure('demo', true);
  scheduler.fire();
  expect(registry.get(twinDemoAtom).cycle).toBe(paused + 1);
  expect(scheduler.pendingCount).toBe(1);
});
it('rejects mode changes that invalidate an active tick even before React commits its effect', () => {
  const { registry, scheduler, runtime } = create();
  runtime.configure('demo', true);
  const stale = scheduler.callbacks()[0];
  twinUiActions.modeSet(registry, 'research');
  stale();
  expect(scheduler.pendingCount).toBe(0);
  expect(registry.get(twinDemoAtom).cycle).toBe(1);
});
it('stops the clock when the Effect child scope closes', () => {
  const { registry, scheduler, runtime } = create();
  runtime.configure('demo', true);
  const stale = scheduler.callbacks()[0];
  runtime.dispose();
  expect(scheduler.pendingCount).toBe(0);
  stale();
  expect(registry.get(twinDemoAtom).cycle).toBe(1);
  expect(() => runtime.configure('demo', true)).toThrow('TwinDemoClockRuntime is disposed');
});
