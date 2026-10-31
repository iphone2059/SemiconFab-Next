import { Effect, Exit, Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { createActor, type Actor } from 'xstate';
import type { AppRuntime } from '@/app/app-runtime';
import type { SceneCommands } from '@/contracts/scene.port';
import { ORIGINAL_TOUR_STOPS } from '@/domain/simulation-original-tour';
import { buildTourScenario, TOUR_INITIAL_CAMERA, TOUR_INITIAL_TARGET } from '@/domain/simulation-tour-scenario';
import { createTourTimeline, type TourFrame, type TourTimeline } from '@/domain/simulation-tour-timeline';
import { twinTourActions } from '@/twin/twin-tour.atom';
import { twinTourMachine } from '@/twin/twin-tour.machine';
export interface TwinTourScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}
export interface TourHudSnapshot {
  readonly tag: string;
  readonly timerText: string;
  readonly progressWidth: string;
  readonly activeDot: number;
}
type TourScenePort = Pick<SceneCommands, 'getCameraPose' | 'setCameraPose'>;
interface TwinTourRuntimeOptions {
  readonly appRuntime: AppRuntime<never>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly scheduler: TwinTourScheduler;
  readonly onHud: (hud: TourHudSnapshot | null) => void;
  readonly onStopped: () => void;
  readonly onWaypoint: (index: number) => void;
}
interface TourSession {
  readonly generation: number;
  readonly timeline: TourTimeline;
  readonly frameMs: number;
  rafHandle: number | null;
  lastFrameMs: number;
  accumulatedMs: number;
  lastWaypoint: number;
}
const runtimes = new WeakMap<AtomRegistry.AtomRegistry, TwinTourRuntime>();
export const browserTwinTourScheduler: TwinTourScheduler = {
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: handle => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};
function toHud(frame: TourFrame): TourHudSnapshot {
  return {
    tag: frame.hudTag,
    timerText: frame.timerText,
    progressWidth: frame.progressWidth,
    activeDot: frame.activeDot,
  };
}
export function registerTwinTourRuntime(registry: AtomRegistry.AtomRegistry, runtime: TwinTourRuntime): () => void {
  if (runtimes.has(registry)) throw new Error('A TwinTourRuntime is already registered for this AtomRegistry');
  runtimes.set(registry, runtime);
  return () => {
    if (runtimes.get(registry) === runtime) runtimes.delete(registry);
  };
}
export function stopTwinTourRuntime(registry: AtomRegistry.AtomRegistry): void {
  runtimes.get(registry)?.stop();
}
export class TwinTourRuntime {
  private readonly scope: Scope.Closeable;
  private readonly actor: Actor<typeof twinTourMachine>;
  private readonly subscription: { unsubscribe(): void };
  private session: TourSession | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: TwinTourRuntimeOptions) {
    this.scope = options.appRuntime.forkScope();
    this.actor = createActor(twinTourMachine);
    this.subscription = this.actor.subscribe(snapshot => {
      twinTourActions.projectionSet(options.registry, {
        active: snapshot.matches('running'),
        waypoint: snapshot.context.waypoint,
      });
    });
    options.appRuntime.runSync(Scope.addFinalizer(this.scope, Effect.sync(() => {
      this.disposed = true;
      this.stopSession();
      if (this.actor.getSnapshot().matches('running')) this.actor.send({ type: 'STOP' });
      this.subscription.unsubscribe();
      this.actor.stop();
    })));
    this.actor.start();
    const snapshot = this.actor.getSnapshot();
    twinTourActions.projectionSet(options.registry, {
      active: snapshot.matches('running'),
      waypoint: snapshot.context.waypoint,
    });
  }
  startTour(scene: () => TourScenePort | null, language: 'zh' | 'en'): TourHudSnapshot {
    if (this.disposed) throw new Error('TwinTourRuntime is disposed');
    if (this.session !== null) this.stop();
    const camera = scene()?.getCameraPose();
    const scenario = buildTourScenario(ORIGINAL_TOUR_STOPS, language, {
      camera: camera
        ? { x: camera.position[0], y: camera.position[1], z: camera.position[2] }
        : TOUR_INITIAL_CAMERA,
      target: camera
        ? { x: camera.target[0], y: camera.target[1], z: camera.target[2] }
        : TOUR_INITIAL_TARGET,
    });
    const timeline = createTourTimeline(scenario);
    const session: TourSession = {
      generation: ++this.generation,
      timeline,
      frameMs: scenario.frameMs,
      rafHandle: null,
      lastFrameMs: this.options.scheduler.now(),
      accumulatedMs: 0,
      lastWaypoint: -1,
    };
    this.session = session;
    timeline.start();
    this.actor.send({ type: 'START' });
    this.options.onWaypoint(0);
    const hud = toHud(timeline.readFrame());
    this.options.onHud(hud);
    session.rafHandle = this.options.scheduler.requestFrame(() => this.step(session, scene));
    return hud;
  }
  stop(): void {
    if (this.disposed) return;
    const active = this.session !== null || this.actor.getSnapshot().matches('running');
    if (!active) return;
    this.stopSession();
    this.actor.send({ type: 'STOP' });
    this.options.onHud(null);
    this.options.onStopped();
  }
  advanceTour(): void {
    const session = this.session;
    if (!session || !this.isCurrent(session)) return;
    if (session.timeline.readFrame().index >= ORIGINAL_TOUR_STOPS.length - 1) {
      this.stop();
      return;
    }
    session.timeline.next();
  }
  previousTour(): void {
    const session = this.session;
    if (!session || !this.isCurrent(session)) return;
    session.timeline.prev();
  }
  dispose(): void {
    if (this.disposed) return;
    this.options.appRuntime.runSync(Scope.close(this.scope, Exit.void));
  }
  private stopSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.generation += 1;
    if (session.rafHandle !== null) this.options.scheduler.cancelFrame(session.rafHandle);
    session.rafHandle = null;
    session.timeline.stop();
  }
  private isCurrent(session: TourSession): boolean {
    return !this.disposed
      && this.session === session
      && this.generation === session.generation
      && this.actor.getSnapshot().matches('running');
  }
  private step(session: TourSession, scene: () => TourScenePort | null): void {
    if (!this.isCurrent(session)) return;
    session.rafHandle = null;
    const now = this.options.scheduler.now();
    session.accumulatedMs += Math.max(0, now - session.lastFrameMs);
    session.lastFrameMs = now;
    const advanceCount = Math.min(8, Math.floor(session.accumulatedMs / session.frameMs));
    if (advanceCount > 0) {
      session.accumulatedMs = Math.max(0, session.accumulatedMs - advanceCount * session.frameMs);
      for (let count = 0; count < advanceCount; count += 1) {
        session.timeline.step();
        if (!session.timeline.readFrame().active) {
          this.stop();
          return;
        }
        if (!this.isCurrent(session)) return;
      }
    }
    const frame = session.timeline.readFrame();
    if (frame.index !== session.lastWaypoint) {
      session.lastWaypoint = frame.index;
      this.actor.send({ type: 'WAYPOINT', waypoint: frame.index });
      this.options.onWaypoint(frame.index);
    }
    scene()?.setCameraPose(
      [frame.camera.x, frame.camera.y, frame.camera.z],
      [frame.target.x, frame.target.y, frame.target.z],
      0,
    );
    this.options.onHud(toHud(frame));
    if (!this.isCurrent(session)) return;
    session.rafHandle = this.options.scheduler.requestFrame(() => this.step(session, scene));
  }
}
