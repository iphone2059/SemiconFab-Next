// @vitest-environment jsdom
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useRef, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waferRoutesQueryOptions } from '@/api/wafer.resource';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';
import { useWaferPlayback } from '@/twin/use-wafer-playback';
import type { FabViewportHandle } from '@/twin/twin-viewer';
import { twinPageAtom, type TwinPageState } from '@/twin/twin-page.atom';
import { twinUiActions, twinUiAtom } from '@/twin/twin-ui.atom';
import { localeActions, localeAtom } from '@/state/locale.atom';

// Keep the real query observer, atoms and domain timeline; only drive the browser
// clock manually so a retained 16x timeline is observable through its page projection.
const routes: Record<WaferProduct, WaferRouteStep[]> = {
  A: [{ step: 1, tool_group: 'TG01_LITHO' }, { step: 2, tool_group: 'TG03_ETCH' }, { step: 3, tool_group: 'TG05_CVD' }],
  B: [{ step: 1, tool_group: 'TG02_TRACK' }, { step: 2, tool_group: 'TG13_WET_BENCH' }, { step: 3, tool_group: 'TG18_INSPECT' }],
  C: [{ step: 1, tool_group: 'TG09_IMPL_MED' }, { step: 2, tool_group: 'TG11_CMP_OX' }, { step: 3, tool_group: 'TG16_MET_CD' }],
};
let now: number;
let nextFrame: number;
const frames = new Map<number, FrameRequestCallback>();
let first: AtomRegistry.AtomRegistry;
let second: AtomRegistry.AtomRegistry;
let client: QueryClient;

beforeEach(() => {
  now = 0;
  nextFrame = 0;
  frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  first = AtomRegistry.make();
  second = AtomRegistry.make();
  first.set(localeAtom, { language: 'en', theme: 'light' });
  second.set(localeAtom, { language: 'en', theme: 'light' });
  client = new QueryClient();
  client.setQueryData(waferRoutesQueryOptions().queryKey, routes);
  twinUiActions.waferOpen(first);
});

afterEach(() => {
  cleanup();
  first.dispose();
  second.dispose();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stepFrames(count: number): void {
  act(() => {
    for (let i = 0; i < count; i += 1) {
      now += 100;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
    }
  });
}

function mountPlayback() {
  let owner = first;
  function Wrapper({ children }: PropsWithChildren) {
    return <RegistryContext.Provider value={owner}><QueryClientProvider client={client}>{children}</QueryClientProvider></RegistryContext.Provider>;
  }
  const hook = renderHook(() => {
    const scene = useRef<FabViewportHandle | null>(null);
    const waferActive = useAtomValue(twinUiAtom, state => state.wafer.active);
    const language = useAtomValue(localeAtom, state => state.language);
    return useWaferPlayback({ scene, waferActive, language, endTour() {}, t: text => text });
  }, { wrapper: Wrapper, reactStrictMode: true });
  return { ...hook, replaceRegistry() { owner = second; hook.rerender(); } };
}

it('discards the previous timeline and HUD when the replacement registry is inactive', () => {
  const hook = mountPlayback();
  act(() => { hook.result.current.changeWaferProduct('B'); hook.result.current.setWaferSpeed(16); });
  stepFrames(2);
  expect(first.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 1 });
  const oldFrame = first.get(twinPageAtom).wafer;
  const freshFrame = second.get(twinPageAtom).wafer;

  hook.replaceRegistry();

  expect(second.get(twinPageAtom).wafer).toBe(freshFrame);
  expect(second.get(twinPageAtom).wafer.hud).toBeUndefined();
  expect(second.get(twinUiAtom).wafer).toMatchObject({ active: false, playing: false, speed: 1 });
  expect(frames.size).toBe(0);
  expect(first.get(twinPageAtom).wafer).toBe(oldFrame);
  act(() => hook.result.current.startWafer());
  expect(second.get(twinPageAtom).wafer).toMatchObject({ product: 'A', index: 0 });
  stepFrames(2);
  expect(second.get(twinPageAtom).wafer.index).toBe(0);
});

it('starts an active replacement registry with its own product and speed', () => {
  twinUiActions.waferOpen(second);
  twinUiActions.waferSpeedSet(second, 4);
  second.update(twinPageAtom, (state): TwinPageState => ({ ...state, wafer: { ...state.wafer, product: 'C' } }));
  const hook = mountPlayback();
  act(() => { hook.result.current.changeWaferProduct('B'); hook.result.current.setWaferSpeed(16); });
  stepFrames(2);
  expect(first.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 1 });
  const oldFrame = first.get(twinPageAtom).wafer;

  hook.replaceRegistry();

  expect(second.get(twinPageAtom).wafer).toMatchObject({ product: 'C', index: 0, completed: false });
  expect(second.get(twinPageAtom).wafer.hud?.badge).toBe('Product C · 3 Steps');
  expect(second.get(twinUiAtom).wafer.speed).toBe(4);
  expect(frames.size).toBe(1);
  stepFrames(2);
  expect(second.get(twinPageAtom).wafer.index).toBe(0);
  stepFrames(3);
  expect(second.get(twinPageAtom).wafer.index).toBe(1);
  expect(first.get(twinPageAtom).wafer).toBe(oldFrame);
});

it('preserves product and progress across same-registry pause, speed, locale and rerenders', () => {
  const hook = mountPlayback();
  act(() => { hook.result.current.changeWaferProduct('B'); hook.result.current.setWaferSpeed(16); });
  stepFrames(2);
  expect(first.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 1 });
  act(() => hook.result.current.toggleWaferPlay());
  stepFrames(5);
  expect(first.get(twinPageAtom).wafer.index).toBe(1);
  act(() => { hook.result.current.setWaferSpeed(1); localeActions.languageSet(first, 'zh'); });
  hook.rerender();
  expect(first.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 1 });
  expect(first.get(twinUiAtom).wafer).toMatchObject({ playing: false, speed: 1 });
  expect(frames.size).toBe(1);
  act(() => hook.result.current.toggleWaferPlay());
  stepFrames(2);
  expect(first.get(twinPageAtom).wafer).toMatchObject({ product: 'B', index: 1 });
});
