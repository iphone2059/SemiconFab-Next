import { Effect, Exit, Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { createActor, type Actor } from 'xstate';
import type { AppRuntime } from '@/app/app-runtime';
import type { SceneCommands } from '@/contracts/scene.port';
import { buildWaferScenario } from '@/domain/wafer-scenario';
import type { WaferProduct, WaferRouteStep } from '@/domain/wafer-route';
import { createWaferTimeline, type WaferFrame, type WaferHud, type WaferTimeline } from '@/domain/wafer-timeline';
import type { TwinLanguage } from '@/twin/twin-i18n';
import { twinWaferActions, twinWaferAtom } from '@/twin/twin-wafer.atom';
import { twinWaferMachine, type TwinWaferSpeed } from '@/twin/twin-wafer.machine';
type WaferScenePort = Pick<SceneCommands, 'setWaferPoint' | 'setWaferTrail' | 'setCameraPose'>;
export interface TwinWaferScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}
interface TwinWaferRuntimeOptions {
  readonly appRuntime: AppRuntime<never>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly scheduler: TwinWaferScheduler;
  readonly scene: () => WaferScenePort | null;
  readonly language: TwinLanguage;
}
interface WaferSession {
  readonly generation: number;
  readonly timeline: WaferTimeline;
  readonly scene: WaferScenePort | null;
  rafHandle: number | null;
  lastFrameMs: number;
  lastPlaying: boolean;
  completed: boolean;
}
const runtimes = new WeakMap<AtomRegistry.AtomRegistry, TwinWaferRuntime>();
export const browserTwinWaferScheduler: TwinWaferScheduler = {
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: handle => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};
export function registerTwinWaferRuntime(registry: AtomRegistry.AtomRegistry, runtime: TwinWaferRuntime): () => void {
  if (runtimes.has(registry)) throw new Error('A TwinWaferRuntime is already registered for this AtomRegistry');
  runtimes.set(registry, runtime);
  return () => {
    if (runtimes.get(registry) === runtime) runtimes.delete(registry);
  };
}
export function stopTwinWaferRuntime(registry: AtomRegistry.AtomRegistry): void {
  runtimes.get(registry)?.close();
}
export class TwinWaferRuntime {
  private readonly scope: Scope.Closeable;
  private readonly actor: Actor<typeof twinWaferMachine>;
  private readonly subscription: { unsubscribe(): void };
  private timeline: WaferTimeline | null = null;
  private session: WaferSession | null = null;
  private generation = 0;
  private language: TwinLanguage;
  private lastHud: WaferHud | undefined;
  private disposed = false;
  constructor(private readonly options: TwinWaferRuntimeOptions) {
    this.language = options.language;
    const initial = options.registry.get(twinWaferAtom);
    this.scope = options.appRuntime.forkScope();
    this.actor = createActor(twinWaferMachine);
    this.subscription = this.actor.subscribe(snapshot => {
      twinWaferActions.projectionSet(options.registry, {
        active: !snapshot.matches('closed'),
        playing: snapshot.matches('playing'),
        speed: snapshot.context.speed,
        product: snapshot.context.product,
        index: snapshot.context.index,
        completed: snapshot.matches('completed'),
      });
    });
    options.appRuntime.runSync(Scope.addFinalizer(this.scope, Effect.sync(() => {
      this.disposed = true;
      this.closeSession();
      this.timeline = null;
      this.subscription.unsubscribe();
      this.actor.stop();
    })));
    this.actor.start();
    this.actor.send({ type: 'RESTORE', product: initial.product, speed: initial.speed });
    twinWaferActions.hudClear(options.registry);
  }
  setRoutes(routes: Record<WaferProduct, WaferRouteStep[]>): void {
    if (this.disposed) throw new Error('TwinWaferRuntime is disposed');
    if (this.timeline !== null) return;
    const context = this.actor.getSnapshot().context;
    const scenario = buildWaferScenario(routes, this.language);
    this.timeline = createWaferTimeline({
      ...scenario,
      clockStartMs: this.options.scheduler.now(),
      product: context.product,
      speed: context.speed,
    });
    this.timeline.close();
    const wasLoading = this.actor.getSnapshot().matches('loading');
    this.actor.send({ type: 'ROUTES_READY' });
    if (wasLoading) this.activateTimeline();
  }
  setLanguage(language: TwinLanguage): void {
    if (this.disposed) throw new Error('TwinWaferRuntime is disposed');
    this.language = language;
    this.timeline?.setLanguage(language === 'zh' ? 'zh-CN' : 'en');
    if (this.timeline && !this.actor.getSnapshot().matches('closed')) this.publishHud(this.timeline.readFrame());
  }
  open(): void {
    if (this.disposed) throw new Error('TwinWaferRuntime is disposed');
    if (!this.actor.getSnapshot().matches('closed')) return;
    this.actor.send({ type: 'OPEN' });
    if (this.actor.getSnapshot().matches('playing')) this.activateTimeline();
  }
  close(): void {
    if (this.disposed) return;
    this.closeSession();
  }
  setProduct(product: WaferProduct): void {
    const timeline = this.requireTimeline();
    timeline.setProduct(product);
    this.actor.send({ type: 'PRODUCT', product });
    this.resetSessionPlayback();
    const frame = timeline.readFrame();
    this.publishFrame(frame);
    this.applySceneFrame(frame, this.session?.scene ?? this.options.scene());
  }
  togglePlay(): void {
    const timeline = this.requireTimeline();
    timeline.togglePlay();
    const frame = timeline.readFrame();
    this.actor.send({ type: 'TOGGLE' });
    if (this.session) {
      this.session.lastPlaying = frame.playing;
      if (frame.playing) this.session.completed = false;
    }
    this.publishHud(frame);
  }
  setSpeed(speed: TwinWaferSpeed): void {
    this.requireTimeline().setSpeed(speed);
    this.actor.send({ type: 'SPEED', speed });
  }
  replay(): void {
    const timeline = this.requireTimeline();
    timeline.replay();
    this.actor.send({ type: 'REPLAY' });
    this.resetSessionPlayback();
    const frame = timeline.readFrame();
    this.publishFrame(frame);
    this.applySceneFrame(frame, this.session?.scene ?? this.options.scene());
  }
  get routesReady(): boolean {
    return this.timeline !== null;
  }
  dispose(): void {
    if (this.disposed) return;
    this.options.appRuntime.runSync(Scope.close(this.scope, Exit.void));
  }
  private requireTimeline(): WaferTimeline {
    if (this.disposed) throw new Error('TwinWaferRuntime is disposed');
    if (this.timeline === null) throw new Error('Wafer routes are not ready');
    return this.timeline;
  }
  private activateTimeline(): void {
    const timeline = this.requireTimeline();
    timeline.open();
    const frame = timeline.readFrame();
    const session: WaferSession = {
      generation: ++this.generation,
      timeline,
      scene: this.options.scene(),
      rafHandle: null,
      lastFrameMs: this.options.scheduler.now(),
      lastPlaying: frame.playing,
      completed: false,
    };
    this.session = session;
    this.publishFrame(frame);
    this.applySceneFrame(frame, session.scene);
    this.scheduleFrame(session);
  }
  private closeSession(): void {
    const session = this.session;
    const active = !this.actor.getSnapshot().matches('closed');
    this.stopFrameLoop();
    this.timeline?.close();
    if (active) this.actor.send({ type: 'CLOSE' });
    this.lastHud = undefined;
    twinWaferActions.hudClear(this.options.registry);
    if (session !== null || active) this.clearScene(session?.scene ?? this.options.scene());
  }
  private stopFrameLoop(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.generation += 1;
    if (session.rafHandle !== null) this.options.scheduler.cancelFrame(session.rafHandle);
    session.rafHandle = null;
  }
  private resetSessionPlayback(): void {
    if (!this.session) return;
    const frame = this.session.timeline.readFrame();
    this.session.lastPlaying = frame.playing;
    this.session.completed = false;
  }
  private isCurrent(session: WaferSession): boolean {
    const snapshot = this.actor.getSnapshot();
    return !this.disposed
      && this.session === session
      && this.generation === session.generation
      && (snapshot.matches('playing') || snapshot.matches('paused') || snapshot.matches('completed'));
  }
  private scheduleFrame(session: WaferSession): void {
    if (!this.isCurrent(session)) return;
    session.rafHandle = this.options.scheduler.requestFrame(() => this.step(session));
  }
  private step(session: WaferSession): void {
    if (!this.isCurrent(session)) return;
    session.rafHandle = null;
    const now = this.options.scheduler.now();
    session.timeline.step(Math.max(0, now - session.lastFrameMs));
    session.lastFrameMs = now;
    const frame = session.timeline.readFrame();
    this.publishFrame(frame);
    this.applySceneFrame(frame, session.scene);
    if (frame.playing !== session.lastPlaying) {
      session.lastPlaying = frame.playing;
      if (!frame.playing && session.timeline.readStats().completed && !session.completed) {
        session.completed = true;
        this.actor.send({ type: 'COMPLETE' });
      }
    }
    this.scheduleFrame(session);
  }
  private publishFrame(frame: WaferFrame): void {
    if (frame.index !== this.actor.getSnapshot().context.index) {
      this.actor.send({ type: 'WAYPOINT', index: frame.index });
    }
    this.publishHud(frame);
  }
  private publishHud(frame: WaferFrame): void {
    if (frame.hud !== this.lastHud) {
      this.lastHud = frame.hud;
      twinWaferActions.hudSet(this.options.registry, frame.hud);
    }
  }
  private applySceneFrame(frame: WaferFrame, scene: WaferScenePort | null): void {
    const { x, y, z } = frame.position;
    scene?.setWaferPoint(x, y, z, true, false, frame.rotationY);
    if (this.options.registry.get(twinWaferAtom).follow) {
      scene?.setCameraPose([frame.camera.x, frame.camera.y, frame.camera.z], [x, y, z], 0);
    }
    scene?.setWaferTrail(this.requireTimeline().readTrailPoints().map(point => [point.x, point.y, point.z] as const));
  }
  private clearScene(scene: WaferScenePort | null): void {
    scene?.setWaferPoint(0, 0, 0, false, false);
    scene?.setWaferTrail([]);
  }
}
