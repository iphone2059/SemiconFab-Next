import { Effect, Exit, Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { createActor, type Actor } from 'xstate';
import type { AppRuntime } from '@/app/app-runtime';
import type { FabToolState } from '@/domain/fab-layout';
import { ResearchReplay, type ResearchSnapshot } from '@/domain/simulation-research-replay';
import { projectReplayStates } from '@/domain/simulation-twin-equipment';
import { twinUiAtom } from '@/twin/twin-ui.atom';
import { twinResearchActions, type TwinResearchProjection, type TwinResearchSpeed, type TwinResearchStatus } from '@/twin/twin-research.atom';
import { twinResearchMachine } from '@/twin/twin-research.machine';
export interface TwinResearchScheduler {
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(handle: number): void;
  now(): number;
}
interface TwinResearchRuntimeOptions {
  readonly appRuntime: AppRuntime<never>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly scheduler: TwinResearchScheduler;
  readonly replayBase: readonly FabToolState[];
  readonly scopeKey: string;
}
const runtimes = new WeakMap<AtomRegistry.AtomRegistry, TwinResearchRuntime>();
export const browserTwinResearchScheduler: TwinResearchScheduler = {
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: handle => window.clearInterval(handle),
  now: () => performance.now(),
};
export function registerTwinResearchRuntime(registry: AtomRegistry.AtomRegistry, runtime: TwinResearchRuntime): () => void {
  if (runtimes.has(registry)) throw new Error('A TwinResearchRuntime is already registered for this AtomRegistry');
  runtimes.set(registry, runtime);
  return () => {
    if (runtimes.get(registry) === runtime) runtimes.delete(registry);
  };
}
export function stopTwinResearchRuntime(registry: AtomRegistry.AtomRegistry): void {
  runtimes.get(registry)?.exit();
}
export class TwinResearchRuntime {
  private readonly scope: Scope.Closeable;
  private readonly actor: Actor<typeof twinResearchMachine>;
  private readonly subscription: { unsubscribe(): void };
  private replay: ResearchReplay | null = null;
  private readonly replayBase: readonly FabToolState[];
  private lastReplayProjection: ReturnType<typeof projectReplayStates> | undefined;
  private timeSec = 0;
  private speed: TwinResearchSpeed = 100;
  private parseError = '';
  private intervalHandle: number | null = null;
  private generation = 0;
  private lastTimeMs = 0;
  private disposed = false;
  constructor(private readonly options: TwinResearchRuntimeOptions) {
    this.replayBase = [...options.replayBase];
    this.scope = options.appRuntime.forkScope();
    this.actor = createActor(twinResearchMachine);
    this.subscription = this.actor.subscribe(() => this.publish());
    options.appRuntime.runSync(Scope.addFinalizer(this.scope, Effect.sync(() => {
      this.stopClock();
      this.disposed = true;
      this.subscription.unsubscribe();
      this.actor.stop();
    })));
    this.actor.start();
    this.publish();
  }
  enter(): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    if (!this.actor.getSnapshot().matches('inactive')) return;
    this.actor.send({ type: 'ENTER' });
    if (this.parseError !== '') this.actor.send({ type: 'FAIL' });
    else if (this.replay !== null) this.actor.send({ type: 'READY' });
  }
  exit(): void {
    if (this.disposed) return;
    this.stopClock();
    if (!this.actor.getSnapshot().matches('inactive')) this.actor.send({ type: 'EXIT' });
  }
  setEvents(text: string): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    if (this.replay !== null || this.parseError !== '') return;
    try {
      this.replay = ResearchReplay.parse(text);
      this.timeSec = Math.min(3600, this.replay.durationSec);
      if (this.actor.getSnapshot().matches('loading')) this.actor.send({ type: 'READY' });
      this.publish();
    } catch (error) {
      this.parseError = error instanceof Error ? error.message : String(error);
      if (this.actor.getSnapshot().matches('loading')) this.actor.send({ type: 'FAIL' });
      this.publish();
    }
  }
  play(): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    const snapshot = this.actor.getSnapshot();
    if (!snapshot.matches('paused') && !snapshot.matches('completed')) throw new Error('Research playback is not paused or completed');
    if (this.timeSec >= this.requireReplay().durationSec) this.timeSec = 0;
    this.actor.send({ type: 'PLAY' });
    this.lastTimeMs = this.options.scheduler.now();
    this.startClock();
    this.publish();
  }
  pause(): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    if (!this.actor.getSnapshot().matches('playing')) return;
    this.stopClock();
    this.actor.send({ type: 'PAUSE' });
  }
  seek(timeSec: number): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    const snapshot = this.actor.getSnapshot();
    if (!snapshot.matches('paused') && !snapshot.matches('playing') && !snapshot.matches('completed')) throw new Error('Research playback is not ready');
    const replay = this.requireReplay();
    this.stopClock();
    this.timeSec = Math.max(0, Math.min(replay.durationSec, timeSec));
    if (!snapshot.matches('paused')) this.actor.send({ type: 'SEEK' });
    this.publish();
  }
  setSpeed(speed: TwinResearchSpeed): void {
    if (this.disposed) throw new Error('TwinResearchRuntime is disposed');
    if (this.replay === null) throw new Error('Research playback is not ready');
    this.speed = speed;
    this.publish();
  }
  dispose(): void {
    if (this.disposed) return;
    this.options.appRuntime.runSync(Scope.close(this.scope, Exit.void));
  }
  private requireReplay(): ResearchReplay {
    if (this.replay === null) throw new Error('Research events are not ready');
    return this.replay;
  }
  private stopClock(): void {
    this.generation += 1;
    if (this.intervalHandle !== null) this.options.scheduler.clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
  private startClock(): void {
    this.stopClock();
    const generation = this.generation;
    this.intervalHandle = this.options.scheduler.setInterval(() => this.step(generation), 100);
  }
  private step(generation: number): void {
    if (this.disposed || this.generation !== generation || !this.actor.getSnapshot().matches('playing')) return;
    if (this.options.registry.get(twinUiAtom).entryMode !== 'research') {
      this.exit();
      return;
    }
    const replay = this.requireReplay();
    const now = this.options.scheduler.now();
    const elapsedSec = Math.max(0, now - this.lastTimeMs) * this.speed / 1000;
    this.lastTimeMs = now;
    this.timeSec = Math.min(replay.durationSec, this.timeSec + elapsedSec);
    if (this.timeSec >= replay.durationSec) {
      this.stopClock();
      this.actor.send({ type: 'COMPLETE' });
    }
    this.publish();
  }
  private publish(): void {
    if (this.disposed) return;
    const status = this.actor.getSnapshot().value as TwinResearchStatus;
    const visible = status === 'paused' || status === 'playing' || status === 'completed';
    const snapshot: ResearchSnapshot | undefined = visible && this.replay !== null
      ? this.replay.snapshot(this.timeSec) : undefined;
    const nextReplayProjection = snapshot === undefined ? undefined : projectReplayStates(snapshot, this.replayBase);
    const previous = this.lastReplayProjection;
    const replayProjection = nextReplayProjection !== undefined && previous !== undefined
      && nextReplayProjection.states.length === previous.states.length
      && nextReplayProjection.states.every((state, index) => state === previous.states[index])
      ? previous : nextReplayProjection;
    this.lastReplayProjection = replayProjection;
    const projection: TwinResearchProjection = {
      scopeKey: this.options.scopeKey,
      status,
      timeSec: this.timeSec,
      speed: this.speed,
      durationSec: this.replay?.durationSec ?? 0,
      eventCount: this.replay?.eventCount ?? 0,
      parseError: this.parseError,
      snapshot,
      replayProjection,
    };
    twinResearchActions.projectionSet(this.options.registry, projection);
  }
}