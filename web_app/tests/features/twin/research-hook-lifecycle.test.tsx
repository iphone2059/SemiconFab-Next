// @vitest-environment jsdom
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it } from 'vitest';
import { FAB_TOOL_STATES } from '@/domain/fab-layout';
import { twinResearchAtom } from '@/twin/twin-research.atom';
import type { TwinResearchScheduler } from '@/twin/twin-research-runtime';
import { useResearchPlayback } from '@/twin/use-research-playback';
import { createTestRuntime, ResourceTestProviders, seedResearchEvents } from '../../support/resource-test-runtime.tsx';
class VirtualResearchScheduler implements TwinResearchScheduler {
  private next = 0;
  private readonly pending = new Map<number, () => void>();
  setInterval(callback: () => void, delayMs: number): number {
    expect(delayMs).toBe(100);
    const id = ++this.next;
    this.pending.set(id, callback);
    return id;
  }
  clearInterval(handle: number): void {
    this.pending.delete(handle);
  }
  now(): number {
    return 0;
  }
  callbacks(): Array<() => void> {
    return [...this.pending.values()];
  }
  get count(): number {
    return this.pending.size;
  }
}
const registry = AtomRegistry.make();
const runtime = createTestRuntime(registry);
const scheduler = new VirtualResearchScheduler();
function Providers({ children }: PropsWithChildren) {
  return <ResourceTestProviders runtime={runtime}>{children}</ResourceTestProviders>;
}
afterEach(async () => {
  cleanup();
  await runtime.dispose();
});
it('mounts once under StrictMode, releases the old viewer and rejects its delayed clock', async () => {
  seedResearchEvents(runtime, [
    { timestamp_sec: 0, event_type: 'wip_sample', payload: { wip_count: 2 } },
    { timestamp_sec: 10, event_type: 'wip_sample', payload: { wip_count: 3 } },
  ].map(event => JSON.stringify(event)).join('\n'));
  const hook = renderHook(({ scopeKey }) => useResearchPlayback({
    mode: 'research', replayBase: FAB_TOOL_STATES, scopeKey, scheduler, t: value => value,
  }), { initialProps: { scopeKey: 'site:fab:epoch-1' }, wrapper: Providers, reactStrictMode: true });
  await waitFor(() => expect(hook.result.current.research?.eventCount).toBe(2));
  act(() => {
    hook.result.current.setResearchTime(0);
    hook.result.current.setResearchPlaying(true);
  });
  expect(scheduler.count).toBe(1);
  const oldCallback = scheduler.callbacks()[0];
  act(() => hook.rerender({ scopeKey: 'site:fab:epoch-2' }));
  await waitFor(() => expect(hook.result.current.research?.eventCount).toBe(2));
  expect(scheduler.count).toBe(0);
  expect(registry.get(twinResearchAtom).scopeKey).toBe('site:fab:epoch-2');
  const before = registry.get(twinResearchAtom);
  act(() => oldCallback());
  expect(registry.get(twinResearchAtom)).toBe(before);
  act(() => {
    hook.result.current.setResearchTime(0);
    hook.result.current.setResearchPlaying(true);
  });
  expect(scheduler.count).toBe(1);
  hook.unmount();
  expect(scheduler.count).toBe(0);
  expect(registry.get(twinResearchAtom).status).toBe('inactive');
});
