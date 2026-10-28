// @vitest-environment jsdom
import { StrictMode, type RefObject } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useTourController,
  type TwinTourController,
  type TwinTourControllerParams,
  type TwinTourScheduler,
} from '../../../src/features/twin/controllers/use-tour-controller';
import type { FabViewportHandle } from '../../../src/features/twin/fab-viewer';
import { resetTwinUiStore, useTwinUiStore } from '../../../src/features/twin/state/twinUiStore';

/** Deterministic frame queue + clock: no wall-clock/RAF timing leaks into the assertions. */
class VirtualFrames implements TwinTourScheduler {
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

  /** Currently scheduled frame callbacks, in scheduling order. */
  frames(): Array<() => void> {
    return [...this.pending.values()];
  }

  /** Advance virtual time, then deliver every frame scheduled before the advance once. */
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
    reload: vi.fn(),
    selectTool: vi.fn(),
    clearSelection: vi.fn(),
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
  };
}

function renderTour(overrides: Partial<TwinTourControllerParams> = {}) {
  const handle = createSceneHandle();
  const scene: RefObject<FabViewportHandle | null> = { current: handle };
  const scheduler = new VirtualFrames();
  const initialProps: TwinTourControllerParams = {
    scene, language: 'zh', scheduler, scopeKey: 'fab-1:epoch-1', ...overrides,
  };
  const view = renderHook((props: TwinTourControllerParams) => useTourController(props), { initialProps });
  return { ...view, handle, scene, scheduler, props: initialProps };
}

function tourActive(): boolean {
  return useTwinUiStore.getState().tour.active;
}

beforeEach(() => resetTwinUiStore());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetTwinUiStore();
});

it('treats a repeated startTour as stop-then-restart instead of stacking RAF loops', () => {
  const { result, scheduler } = renderTour();
  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  expect(tourActive()).toBe(true);
  const seed = result.current.tourHudSeed;
  expect(seed?.tag).toBeTruthy();
  const firstFrame = scheduler.frames()[0];
  expect(firstFrame).toBeDefined();

  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  expect(result.current.tourHudSeed?.tag).toBe(seed?.tag);
  // The first loop's RAF was explicitly cancelled by the restart.
  expect(scheduler.cancelled).toBe(1);

  // The superseded generation's frame is stale: it must neither schedule a
  // second loop nor write the store.
  act(() => firstFrame());
  expect(scheduler.pendingCount).toBe(1);
  expect(scheduler.requested).toBe(2);
  expect(tourActive()).toBe(true);
});

it('start/stop/start reuses one loop slot and ignores late frames from the stopped generation', () => {
  const { result, scheduler, handle } = renderTour();
  act(() => result.current.startTour());
  act(() => scheduler.advance(100));
  expect(scheduler.pendingCount).toBe(1);
  expect(vi.mocked(handle.setCameraPose).mock.calls.length).toBeGreaterThan(0);
  const staleFrame = scheduler.frames()[0];

  act(() => result.current.endTour());
  expect(scheduler.pendingCount).toBe(0);
  expect(scheduler.cancelled).toBe(1);
  expect(tourActive()).toBe(false);
  expect(result.current.tourHudSeed).toBeNull();

  // A frame already queued before stop must be a no-op.
  act(() => staleFrame());
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);

  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  expect(result.current.tourHudSeed).not.toBeNull();
  const poseCallsBefore = vi.mocked(handle.setCameraPose).mock.calls.length;

  // A late RAF from the previous generation must not advance or reschedule the
  // new timeline (generation + owned timeline check, not just a shared ref).
  act(() => staleFrame());
  expect(scheduler.pendingCount).toBe(1);
  expect(vi.mocked(handle.setCameraPose).mock.calls.length).toBe(poseCallsBefore);
  expect(tourActive()).toBe(true);
});

it('stops the running tour when the owner scope changes (FAB switch / viewer recreation)', () => {
  const { result, scheduler, rerender, props } = renderTour();
  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  const staleFrame = scheduler.frames()[0];

  act(() => rerender({ ...props, scopeKey: 'fab-2:epoch-2' }));
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);
  expect(result.current.tourHudSeed).toBeNull();

  act(() => staleFrame());
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);
});

it('routes manual camera input, finishTour and unmount through the same stop', () => {
  const { result, scheduler, unmount } = renderTour();
  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  act(() => result.current.cancelTourIfRunning());
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);

  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  act(() => result.current.finishTour());
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);

  act(() => result.current.startTour());
  expect(scheduler.pendingCount).toBe(1);
  unmount();
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);
});

it('mounts one controller under StrictMode and releases the loop on unmount', () => {
  const handle = createSceneHandle();
  const scene: RefObject<FabViewportHandle | null> = { current: handle };
  const scheduler = new VirtualFrames();
  const api: { current: TwinTourController | null } = { current: null };

  function TourHarness() {
    api.current = useTourController({
      scene, language: 'zh', scheduler, scopeKey: 'fab-1:epoch-1',
    });
    return null;
  }

  const { unmount } = render(<StrictMode><TourHarness /></StrictMode>);
  expect(api.current).not.toBeNull();
  act(() => api.current?.startTour());
  expect(scheduler.pendingCount).toBe(1);

  const staleFrame = scheduler.frames()[0];
  unmount();
  expect(scheduler.pendingCount).toBe(0);
  expect(tourActive()).toBe(false);
  act(() => staleFrame());
  expect(scheduler.pendingCount).toBe(0);
});
