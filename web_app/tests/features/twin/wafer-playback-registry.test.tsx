// @vitest-environment jsdom
import { useAtomValue } from '@effect/atom-react';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';
import { useWaferPlayback } from '@/twin/use-wafer-playback';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import { twinWaferAtom, twinWaferActions } from '@/twin/twin-wafer.atom';
import { localeActions, localeAtom } from '@/state/locale.atom';
import type { TwinWaferScheduler } from '@/twin/twin-wafer-runtime';
import { stopTwinWaferRuntime } from '@/twin/twin-wafer-runtime';
import { createTestRuntime, seedWaferRoutes, ResourceTestProviders, type AppRuntime } from '../../support/resource-test-runtime.tsx';
const routes: Record<WaferProduct, WaferRouteStep[]> = {
  A: [{ step: 1, tool_group: 'TG01_LITHO' }, { step: 2, tool_group: 'TG03_ETCH' }, { step: 3, tool_group: 'TG05_CVD' }],
  B: [{ step: 1, tool_group: 'TG02_TRACK' }, { step: 2, tool_group: 'TG13_WET_BENCH' }, { step: 3, tool_group: 'TG18_INSPECT' }],
  C: [{ step: 1, tool_group: 'TG09_IMPL_MED' }, { step: 2, tool_group: 'TG11_CMP_OX' }, { step: 3, tool_group: 'TG16_MET_CD' }],
};
class VirtualFrames implements TwinWaferScheduler {
  private handle = 0;
  private readonly pending = new Map<number, () => void>();
  private clockMs = 0;
  requested = 0;
  cancelled = 0;
  requestFrame(callback: () => void): number {
    const handle = ++this.handle;
    this.pending.set(handle, callback);
    this.requested += 1;
    return handle;
  }
  cancelFrame(handle: number): void {
    this.cancelled += 1;
    this.pending.delete(handle);
  }
  now(): number {
    return this.clockMs;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  frames(): Array<() => void> {
    return [...this.pending.values()];
  }
  advance(ms: number): void {
    this.clockMs += ms;
    const due = [...this.pending.entries()];
    for (const [handle, callback] of due) {
      if (!this.pending.has(handle)) continue;
      this.pending.delete(handle);
      callback();
    }
  }
}
function createSceneHandle(): FabViewportHandle {
  return {
    setView: vi.fn(),
    setCameraPose: vi.fn(),
    getCameraPose: vi.fn(() => null),
    zoom: vi.fn(),
    resize: vi.fn(),
    clearSelection: vi.fn(),
    selectTool: vi.fn(),
    setLayer: vi.fn(),
    setToolState: vi.fn(),
    setTour: vi.fn(),
    setExplodeFactor: vi.fn(),
    setBasement: vi.fn(),
    setDual: vi.fn(),
    setCutPlane: vi.fn(),
    setXRayFilter: vi.fn(),
    setWaferPoint: vi.fn(),
    setWaferTrail: vi.fn(),
    focusPatrol: vi.fn(),
    setLanguage: vi.fn(),
    reload: vi.fn(),
  };
}
let first: AtomRegistry.AtomRegistry;
let second: AtomRegistry.AtomRegistry;
let firstRuntime: AppRuntime<never>;
let secondRuntime: AppRuntime<never>;
beforeEach(() => {
  first = AtomRegistry.make();
  second = AtomRegistry.make();
  first.set(localeAtom, { language: 'en', theme: 'light' });
  second.set(localeAtom, { language: 'en', theme: 'light' });
  firstRuntime = createTestRuntime(first);
  secondRuntime = createTestRuntime(second);
  seedWaferRoutes(firstRuntime, routes);
  seedWaferRoutes(secondRuntime, routes);
});
afterEach(async () => {
  cleanup();
  await firstRuntime.dispose();
  await secondRuntime.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mountPlayback() {
  let ownerRuntime = firstRuntime;
  const handle = createSceneHandle();
  const scene = { current: handle as FabViewportHandle | null };
  const scheduler = new VirtualFrames();
  const initialProps = { scopeKey: 'fab-1:epoch-1' };
  function Wrapper({ children }: PropsWithChildren) {
    return <ResourceTestProviders runtime={ownerRuntime}>{children}</ResourceTestProviders>;
  }
  const hook = renderHook(({ scopeKey }) => {
    const waferActive = useAtomValue(twinWaferAtom, state => state.active);
    const language = useAtomValue(localeAtom, state => state.language);
    return useWaferPlayback({
      scene,
      waferActive,
      language,
      endTour() {},
      scopeKey,
      scheduler,
      t: text => text,
    });
  }, { initialProps, wrapper: Wrapper, reactStrictMode: true });
  return {
    ...hook,
    handle,
    scene,
    scheduler,
    replaceScene() {
      const replacement = createSceneHandle();
      scene.current = replacement;
      return replacement;
    },
    replaceRegistry() {
      ownerRuntime = secondRuntime;
      hook.rerender({ scopeKey: 'fab-1:epoch-1' });
    },
  };
}
function frameCount(handle: FabViewportHandle, method: 'setWaferPoint' | 'setWaferTrail' | 'setCameraPose'): number {
  return vi.mocked(handle[method]).mock.calls.length;
}
async function startPlayback(
  result: { current: ReturnType<typeof useWaferPlayback> },
  registry: AtomRegistry.AtomRegistry,
): Promise<void> {
  act(() => result.current.startWafer());
  await waitFor(() => {
    expect(result.current.routesReady).toBe(true);
    expect(registry.get(twinWaferAtom)).toMatchObject({ active: true, playing: true });
  });
}
it('owns one RAF loop and preserves the timeline across user close/reopen', async () => {
  const { result, scheduler, handle } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  expect(first.get(twinWaferAtom)).toMatchObject({ active: true, playing: true, product: 'A', speed: 1 });
  expect(scheduler.pendingCount).toBe(1);
  const staleFrame = scheduler.frames()[0];
  act(() => result.current.startWafer());
  expect(scheduler.pendingCount).toBe(1);
  expect(scheduler.requested).toBe(1);
  for (let frame = 0; frame < 21; frame += 1) act(() => scheduler.advance(100));
  const index = first.get(twinWaferAtom).index;
  expect(index).toBe(1);
  act(() => result.current.closeWafer());
  expect(first.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, hud: undefined });
  expect(scheduler.pendingCount).toBe(0);
  const callsAfterClose = frameCount(handle, 'setWaferPoint');
  act(() => staleFrame?.());
  expect(frameCount(handle, 'setWaferPoint')).toBe(callsAfterClose);
  await startPlayback(result, first);
  expect(first.get(twinWaferAtom)).toMatchObject({ active: true, playing: true, index });
  expect(scheduler.pendingCount).toBe(1);
});
it('keeps 20 Hz frame writes on the imperative scene port without Atom notifications', async () => {
  const { result, scheduler, handle } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  first.get(twinWaferAtom);
  let notifications = 0;
  const unsubscribe = first.subscribe(twinWaferAtom, () => { notifications += 1; });
  const pointCalls = frameCount(handle, 'setWaferPoint');
  const cameraCalls = frameCount(handle, 'setCameraPose');
  const trailCalls = frameCount(handle, 'setWaferTrail');
  for (let frame = 0; frame < 20; frame += 1) act(() => scheduler.advance(50));
  expect(frameCount(handle, 'setWaferPoint')).toBe(pointCalls + 20);
  expect(frameCount(handle, 'setCameraPose')).toBe(cameraCalls + 20);
  expect(frameCount(handle, 'setWaferTrail')).toBe(trailCalls + 20);
  expect(notifications).toBe(0);
  unsubscribe();
});
it('keeps product, speed, pause, locale and waypoint projections synchronized', async () => {
  const { result, scheduler } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  act(() => {
    result.current.changeWaferProduct('B');
    result.current.setWaferSpeed(16);
  });
  act(() => scheduler.advance(100));
  act(() => scheduler.advance(100));
  expect(first.get(twinWaferAtom)).toMatchObject({ product: 'B', speed: 16, index: 1, playing: true });
  act(() => result.current.toggleWaferPlay());
  for (let frame = 0; frame < 5; frame += 1) act(() => scheduler.advance(100));
  expect(first.get(twinWaferAtom)).toMatchObject({ product: 'B', index: 1, playing: false });
  act(() => {
    result.current.setWaferSpeed(1);
    localeActions.languageSet(first, 'zh');
  });
  await waitFor(() => expect(first.get(twinWaferAtom).hud?.status).toBe('已暂停'));
  act(() => result.current.toggleWaferPlay());
  expect(first.get(twinWaferAtom).playing).toBe(true);
  act(() => result.current.replayWafer());
  expect(first.get(twinWaferAtom)).toMatchObject({ product: 'B', index: 0, playing: true, completed: false });
});
it('distinguishes a user pause from route completion', async () => {
  const { result, scheduler } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  act(() => result.current.setWaferSpeed(16));
  act(() => scheduler.advance(100));
  act(() => result.current.toggleWaferPlay());
  expect(first.get(twinWaferAtom)).toMatchObject({ playing: false, completed: false, index: 0 });
  for (let frame = 0; frame < 3; frame += 1) act(() => scheduler.advance(100));
  expect(first.get(twinWaferAtom)).toMatchObject({ playing: false, completed: false, index: 0 });
  act(() => result.current.toggleWaferPlay());
  for (let frame = 0; frame < 8; frame += 1) act(() => scheduler.advance(100));
  expect(first.get(twinWaferAtom)).toMatchObject({ active: true, playing: false, completed: true, index: 2 });
  expect(scheduler.pendingCount).toBe(1);
});
it('stops the old viewer epoch and rejects its late frame callback', async () => {
  const { result, scheduler, rerender, handle, replaceScene } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  const staleFrame = scheduler.frames()[0];
  const replacementScene = replaceScene();
  act(() => rerender({ scopeKey: 'fab-1:epoch-2' }));
  expect(scheduler.pendingCount).toBe(0);
  expect(first.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, hud: undefined });
  act(() => staleFrame?.());
  expect(frameCount(replacementScene, 'setWaferPoint')).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
  expect(frameCount(handle, 'setWaferPoint')).toBeGreaterThan(0);
});
it('keeps product and speed isolated when the AtomRegistry is replaced', async () => {
  twinWaferActions.projectionSet(second, {
    active: false, playing: false, speed: 4, product: 'C', index: 0, completed: false,
  });
  const { result, scheduler, replaceRegistry } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  act(() => {
    result.current.changeWaferProduct('B');
    result.current.setWaferSpeed(16);
  });
  act(() => scheduler.advance(100));
  expect(first.get(twinWaferAtom)).toMatchObject({ product: 'B', speed: 16 });
  replaceRegistry();
  expect(first.get(twinWaferAtom)).toMatchObject({ active: false, playing: false });
  expect(second.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, product: 'C', speed: 4 });
  expect(scheduler.pendingCount).toBe(0);
  await startPlayback(result, second);
  expect(second.get(twinWaferAtom)).toMatchObject({ active: true, product: 'C', speed: 4 });
  expect(scheduler.pendingCount).toBe(1);
});
it('routes external process exclusion and unmount through the same Scope teardown', async () => {
  const { result, scheduler, unmount } = mountPlayback();
  await waitFor(() => expect(result.current.ready).toBe(true));
  await startPlayback(result, first);
  expect(scheduler.pendingCount).toBe(1);
  act(() => stopTwinWaferRuntime(first));
  expect(scheduler.pendingCount).toBe(0);
  expect(first.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, hud: undefined });
  await startPlayback(result, first);
  expect(scheduler.pendingCount).toBe(1);
  unmount();
  expect(scheduler.pendingCount).toBe(0);
  expect(first.get(twinWaferAtom)).toMatchObject({ active: false, playing: false, hud: undefined });
});
