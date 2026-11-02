import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterEach, expect, it, vi } from 'vitest';
import { FAB_TOOL_STATES } from '@/domain/fab-layout';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';
import { twinResearchAtom } from '@/twin/twin-research.atom';
import { registerTwinResearchRuntime, TwinResearchRuntime, type TwinResearchScheduler } from '@/twin/twin-research-runtime';
import { registerTwinTourRuntime, TwinTourRuntime, type TwinTourScheduler } from '@/twin/twin-tour-runtime';
import { registerTwinWaferRuntime, TwinWaferRuntime, type TwinWaferScheduler } from '@/twin/twin-wafer-runtime';
import { stopOtherTwinPlaybacks, type TwinForegroundOwner } from '@/twin/twin-playback-coordination';
import { twinTourAtom } from '@/twin/twin-tour.atom';
import { twinWaferAtom } from '@/twin/twin-wafer.atom';
import { createTwinUiState } from '@/twin/twin-state';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { createTestRuntime } from '../../support/resource-test-runtime.tsx';
class VirtualScheduler implements TwinTourScheduler, TwinWaferScheduler, TwinResearchScheduler {
  private next = 0;
  private readonly frames = new Map<number, () => void>();
  private readonly intervals = new Map<number, () => void>();
  requestFrame(callback: () => void): number {
    const id = ++this.next;
    this.frames.set(id, callback);
    return id;
  }
  cancelFrame(id: number): void {
    this.frames.delete(id);
  }
  setInterval(callback: () => void, delayMs: number): number {
    expect(delayMs).toBe(100);
    const id = ++this.next;
    this.intervals.set(id, callback);
    return id;
  }
  clearInterval(id: number): void {
    this.intervals.delete(id);
  }
  now(): number {
    return 0;
  }
  get pendingFrames(): number {
    return this.frames.size;
  }
  get pendingIntervals(): number {
    return this.intervals.size;
  }
  staleCallbacks(): Array<() => void> {
    return [...this.frames.values(), ...this.intervals.values()];
  }
}
const routes: Record<WaferProduct, WaferRouteStep[]> = {
  A: [{ step: 1, tool_group: 'TG01_LITHO' }],
  B: [{ step: 1, tool_group: 'TG02_TRACK' }],
  C: [{ step: 1, tool_group: 'TG03_ETCH' }],
};
const disposals = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const dispose of disposals) await dispose();
  disposals.clear();
  vi.restoreAllMocks();
});
function create() {
  const registry = AtomRegistry.make();
  registry.set(twinUiAtom, createTwinUiState('research'));
  const appRuntime = createTestRuntime(registry);
  const scheduler = new VirtualScheduler();
  const scene = { setWaferPoint: vi.fn(), setWaferTrail: vi.fn(), setCameraPose: vi.fn() };
  const tour = new TwinTourRuntime({
    appRuntime, registry, scheduler, onHud() {}, onStopped() {}, onWaypoint() {},
  });
  const wafer = new TwinWaferRuntime({ appRuntime, registry, scheduler, scene: () => scene, language: 'en' });
  const research = new TwinResearchRuntime({ appRuntime, registry, scheduler, replayBase: FAB_TOOL_STATES, scopeKey: 'site:fab:epoch' });
  const unregister = [
    registerTwinTourRuntime(registry, tour),
    registerTwinWaferRuntime(registry, wafer),
    registerTwinResearchRuntime(registry, research),
  ];
  wafer.setRoutes(routes);
  tour.startTour(() => null, 'en');
  wafer.open();
  research.enter();
  research.setEvents([
    { timestamp_sec: 0, event_type: 'wip_sample', payload: { wip_count: 1 } },
    { timestamp_sec: 10, event_type: 'wip_sample', payload: { wip_count: 2 } },
  ].map(event => JSON.stringify(event)).join('\n'));
  research.seek(0);
  research.play();
  disposals.add(async () => {
    for (const release of unregister) release();
    tour.dispose();
    wafer.dispose();
    research.dispose();
    await appRuntime.dispose();
  });
  return { registry, scheduler, tour, wafer, research };
}
for (const owner of ['tour', 'wafer', 'research', null] as const satisfies readonly TwinForegroundOwner[]) {
  it(`retains only the ${owner ?? 'no'} foreground runtime when coordinating a transition`, () => {
    const { registry, scheduler } = create();
    expect(scheduler.pendingFrames).toBe(2);
    expect(scheduler.pendingIntervals).toBe(1);
    const callbacks = scheduler.staleCallbacks();
    stopOtherTwinPlaybacks(registry, owner);
    expect(registry.get(twinTourAtom).active).toBe(owner === 'tour');
    expect(registry.get(twinWaferAtom).active).toBe(owner === 'wafer');
    expect(registry.get(twinResearchAtom).status).toBe(owner === 'research' ? 'playing' : 'inactive');
    expect(scheduler.pendingFrames).toBe(owner === null ? 0 : owner === 'research' ? 0 : 1);
    expect(scheduler.pendingIntervals).toBe(owner === 'research' ? 1 : 0);
    for (const callback of callbacks) callback();
    expect(registry.get(twinTourAtom).active).toBe(owner === 'tour');
    expect(registry.get(twinWaferAtom).active).toBe(owner === 'wafer');
    expect(registry.get(twinResearchAtom).status).toBe(owner === 'research' ? 'playing' : 'inactive');
  });
}
it('is idempotent when all owners are stopped and does not schedule new work', () => {
  const { registry, scheduler } = create();
  stopOtherTwinPlaybacks(registry, null);
  stopOtherTwinPlaybacks(registry, null);
  expect(scheduler.pendingFrames).toBe(0);
  expect(scheduler.pendingIntervals).toBe(0);
});
