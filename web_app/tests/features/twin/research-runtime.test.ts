import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { afterEach, expect, it, vi } from 'vitest';
import { ResearchReplay } from '@/domain/simulation-research-replay';
import { FAB_LAYOUT, FAB_TOOL_STATES } from '@/domain/fab-layout';
import { TWIN_LAYOUT_IDENTITIES } from '@/domain/fab-layout-identities';
import { createTwinUiState } from '@/twin/twin-state';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { readResearchToolStates, twinResearchAtom } from '@/twin/twin-research.atom';
import { registerTwinResearchRuntime, stopTwinResearchRuntime, TwinResearchRuntime, type TwinResearchScheduler } from '@/twin/twin-research-runtime';
import { createTestRuntime } from '../../support/resource-test-runtime.tsx';
class VirtualIntervals implements TwinResearchScheduler {
  private clockMs = 0;
  private nextHandle = 0;
  private readonly pending = new Map<number, () => void>();
  setInterval(callback: () => void, delayMs: number): number {
    expect(delayMs).toBe(100);
    const handle = ++this.nextHandle;
    this.pending.set(handle, callback);
    return handle;
  }
  clearInterval(handle: number): void {
    this.pending.delete(handle);
  }
  now(): number {
    return this.clockMs;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  callbacks(): Array<() => void> {
    return [...this.pending.values()];
  }
  advance(ms: number): void {
    this.clockMs += ms;
    for (const callback of [...this.pending.values()]) callback();
  }
}
const events = [
  { timestamp_sec: 0, event_type: 'wip_sample', payload: { wip_count: 5 } },
  { timestamp_sec: 0, event_type: 'tool_state_change', payload: { machine_id: 'M01', tool_group_id: 'TG01', semi_e10_state: 'SBY_standby' } },
  { timestamp_sec: 10, event_type: 'wip_sample', payload: { wip_count: 6 } },
  { timestamp_sec: 10, event_type: 'tool_state_change', payload: { machine_id: 'M01', tool_group_id: 'TG01', semi_e10_state: 'PR_productive' } },
  { timestamp_sec: 20, event_type: 'wip_sample', payload: { wip_count: 7 } },
].map(event => JSON.stringify(event)).join('\n');
const active = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const dispose of active) await dispose();
  active.clear();
  vi.restoreAllMocks();
});
function create(scopeKey = 'fab-a:epoch-1') {
  const registry = AtomRegistry.make();
  registry.set(twinUiAtom, createTwinUiState('research'));
  const appRuntime = createTestRuntime(registry);
  const scheduler = new VirtualIntervals();
  const runtime = new TwinResearchRuntime({
    appRuntime,
    registry,
    scheduler,
    replayBase: FAB_TOOL_STATES,
    scopeKey,
  });
  const unregister = registerTwinResearchRuntime(registry, runtime);
  const dispose = async () => {
    unregister();
    runtime.dispose();
    await appRuntime.dispose();
  };
  active.add(dispose);
  return { runtime, registry, scheduler, dispose };
}
it('advances an indexed research snapshot with a scoped 100 ms interval and completes exactly once', () => {
  const { runtime, registry, scheduler } = create();
  runtime.enter();
  runtime.setEvents(events);
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'paused', timeSec: 20, eventCount: 5, durationSec: 20 });
  runtime.seek(0);
  runtime.play();
  expect(scheduler.pendingCount).toBe(1);
  scheduler.advance(100);
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'playing', timeSec: 10 });
  expect(registry.get(twinResearchAtom).snapshot?.wip).toBe(6);
  expect(registry.get(twinResearchAtom).snapshot?.machineStates.get('M01')).toBe('PR_productive');
  scheduler.advance(100);
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'completed', timeSec: 20 });
  expect(scheduler.pendingCount).toBe(0);
  runtime.setSpeed(10);
  runtime.play();
  scheduler.advance(100);
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'playing', timeSec: 1, speed: 10 });
  expect(scheduler.pendingCount).toBe(1);
});
it('publishes a new equipment array when an indexed mapped machine actually changes state', () => {
  const { runtime, registry, scheduler } = create();
  const identity = TWIN_LAYOUT_IDENTITIES.find(value => value.replayTarget)!;
  const text = [
    { timestamp_sec: 0, event_type: 'tool_state_change', payload: { machine_id: identity.machineId, tool_group_id: 'TG01', semi_e10_state: 'SBY_standby' } },
    { timestamp_sec: 10, event_type: 'tool_state_change', payload: { machine_id: identity.machineId, tool_group_id: 'TG01', semi_e10_state: 'PR_productive' } },
  ].map(value => JSON.stringify(value)).join('\n');
  runtime.enter();
  runtime.setEvents(text);
  runtime.seek(0);
  const before = registry.get(twinResearchAtom).replayProjection;
  expect(before).toBeDefined();
  runtime.play();
  scheduler.advance(100);
  const after = registry.get(twinResearchAtom).replayProjection;
  expect(after).not.toBe(before);
  const changed = TWIN_LAYOUT_IDENTITIES.findIndex(row => row.machineId === identity.machineId && row.replayTarget);
  expect(before?.states[changed]).toBe('idle');
  expect(after?.states[changed]).toBe('running');
});
it('invalidates captured callbacks on pause, leave, re-entry and disposal', () => {
  const { runtime, registry, scheduler } = create();
  runtime.enter();
  runtime.setEvents(events);
  runtime.seek(0);
  runtime.play();
  const stale = scheduler.callbacks()[0];
  stopTwinResearchRuntime(registry);
  const exited = registry.get(twinResearchAtom);
  expect(exited.status).toBe('inactive');
  expect(scheduler.pendingCount).toBe(0);
  stale();
  expect(registry.get(twinResearchAtom)).toBe(exited);
  runtime.enter();
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'paused', timeSec: 0 });
  runtime.play();
  runtime.pause();
  expect(scheduler.pendingCount).toBe(0);
  expect(registry.get(twinResearchAtom).status).toBe('paused');
  runtime.dispose();
  expect(scheduler.pendingCount).toBe(0);
  expect(() => runtime.play()).toThrow('TwinResearchRuntime is disposed');
});
it('keeps scoped replay states separate from a prior viewer while retaining its fixed base', () => {
  const { runtime, registry } = create('fab-a:epoch-1');
  const base = FAB_TOOL_STATES;
  runtime.enter();
  runtime.setEvents(events);
  runtime.seek(10);
  const accepted = registry.get(twinResearchAtom);
  expect(accepted.replayProjection).toBeDefined();
  expect(readResearchToolStates(registry, 'fab-a:epoch-1', base)).toBe(accepted.replayProjection?.states);
  expect(readResearchToolStates(registry, 'fab-b:epoch-1', base)).toBe(base);
  runtime.setReplayBase(base);
  expect(registry.get(twinResearchAtom).replayProjection?.states).toHaveLength(FAB_LAYOUT.length);
});
it('keeps parse errors distinct from transport errors and does not start a timer after re-entry', () => {
  const { runtime, registry, scheduler } = create();
  vi.spyOn(ResearchReplay, 'parse').mockImplementation(() => { throw new Error('invalid research JSONL'); });
  runtime.enter();
  runtime.setEvents(events);
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'failed', parseError: 'invalid research JSONL' });
  runtime.exit();
  runtime.enter();
  expect(registry.get(twinResearchAtom)).toMatchObject({ status: 'failed', parseError: 'invalid research JSONL' });
  expect(scheduler.pendingCount).toBe(0);
});
it('prevents direct play/seek before the actor and data are ready', () => {
  const { runtime } = create();
  expect(() => runtime.play()).toThrow('Research playback is not paused or completed');
  expect(() => runtime.seek(2)).toThrow('Research playback is not ready');
});