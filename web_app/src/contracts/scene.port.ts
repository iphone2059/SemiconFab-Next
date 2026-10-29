/**
 * Application-owned scene port (R-04).
 *
 * Features and state depend on this contract only; the rendering layer implements it
 * (`rendering/lite-backend.ts`). The port is deliberately independent of Babylon Lite,
 * GPU engine details and React so the browser-facing lifetime can be exercised and
 * type-checked without a device.
 *
 * Contract rules:
 * - Every capability in {@link SceneCommands} is REQUIRED. There is no optional
 *   `setView?`/`resize?`/`selectTool?` surface: an implementation that cannot provide a
 *   product capability must not satisfy {@link ScenePort} at all. The negative type
 *   tests in `tests/types/scene-port-types.ts` fail the build if this regresses.
 * - The only optional capability group is acceptance-test tooling, named explicitly in
 *   {@link SceneAcceptanceCapabilities}; product code must never branch on it.
 * - `mount`/`dispose` form one idempotent lifetime. `mount` resolves with a
 *   discriminated outcome (ready/cancelled/failed); every later transition (device
 *   loss, recoverable rebuild, terminal failure) is reported through the readonly
 *   lifecycle callback so callers never parse display text for control flow.
 */
import type { FabToolState } from '@/domain/fab-layout';

/** Domain-space point (metres, right-handed Next frame). */
export type Vec3 = readonly [number, number, number];

export interface FabPlacement {
  readonly fabId: string;
  readonly code: string;
  readonly position: Vec3;
}

export type SceneViewPreset = 'iso' | 'top' | 'reset' | 'focus' | 'litho' | 'airshower' | 'etch' | 'oht';
export type SceneLayer = 'amhs' | 'ceiling' | 'roof' | 'subfab' | 'heatmap' | 'airflow' | 'xray';
export type CutAxis = 'X' | 'Y' | 'Z';
export type XRayFilter = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';
export type SceneLanguage = 'zh' | 'en';

export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
}

export interface PickedTool {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly category: string;
  readonly vendor: string;
  readonly model: string;
  readonly state: FabToolState;
}

export interface HoveredTool {
  readonly tool: PickedTool;
  readonly x: number;
  readonly y: number;
}

export interface AmhsStats {
  readonly active: number;
  readonly total: number;
  readonly queued: number;
  readonly completed: number;
  readonly avgDelivery: number | null;
}

/**
 * Readonly scene lifecycle transitions. `message` is display copy only; callers must
 * switch on `type`, never on the text. `recovering` distinguishes a device loss that the
 * implementation is rebuilding from a terminal `failed` mount or recovery.
 */
export type SceneLifecycleEvent =
  | { readonly type: 'initializing'; readonly message: string }
  | { readonly type: 'ready'; readonly message: string }
  | { readonly type: 'recovering'; readonly message: string; readonly cause: 'device-lost' }
  | { readonly type: 'failed'; readonly message: string; readonly error: unknown };

/** Readonly callback collection handed to the scene once per mount. */
export interface SceneCallbacks {
  readonly onLifecycle: (event: SceneLifecycleEvent) => void;
  readonly onToolPick: (tool: PickedTool | null) => void;
  readonly onToolHover: (hover: HoveredTool | null) => void;
  readonly onAmhsStats: (stats: AmhsStats) => void;
  /** Latest tool-state snapshot for the frame loop; read at most once per rendered frame. */
  readonly getToolStates: () => readonly FabToolState[];
}

/**
 * Strongly typed mount options replacing the former long positional list.
 *
 * `viewerId` is the stable identity of this viewer instance (the React epoch). An
 * implementation bound to one viewer must reject a mount for a different identity
 * instead of silently reusing GPU resources across viewers. `signal` cancels the
 * mount and disposes the scene lifetime; callbacks must not be invoked after abort.
 */
export interface SceneMountOptions {
  readonly viewerId: string;
  readonly canvas: HTMLCanvasElement;
  readonly fabs: readonly FabPlacement[];
  readonly signal: AbortSignal;
  readonly callbacks: SceneCallbacks;
}

/**
 * Discriminated mount result. Cancellation is an expected lifecycle event (unmount,
 * viewer replacement) and is not reported as a failure; a failure has already been
 * reported through `onLifecycle` when the rejection resolves with this outcome.
 */
export type SceneMountOutcome =
  | { readonly status: 'ready' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * Formal product capabilities. All are required: a scene that cannot execute one of
 * these commands is not a valid {@link ScenePort}. Implementations may ignore commands
 * while no scene is mounted, but they must never hide a missing capability behind an
 * optional method.
 */
export interface SceneCommands {
  setView(preset: SceneViewPreset, fabId?: string): void;
  setCameraPose(position: Vec3, target: Vec3, durationMs: number): void;
  getCameraPose(): CameraPose | null;
  zoom(deltaY: number): void;
  resize(): void;
  clearSelection(): void;
  selectTool(index: number, focus?: boolean): void;
  setLayer(layer: SceneLayer, visible: boolean): void;
  setToolState(index: number, state: FabToolState): void;
  setTour(active: boolean): void;
  setExplodeFactor(factor: number, modeActive?: boolean): void;
  setBasement(active: boolean): void;
  setDual(active: boolean): void;
  setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void;
  setXRayFilter(filter: XRayFilter | null): void;
  setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void;
  setWaferTrail(points: readonly Vec3[]): void;
  focusPatrol(): void;
  setLanguage(language: SceneLanguage): void;
}

/**
 * Genuinely optional capability group exposed by acceptance/perf tooling only.
 * Product features must not depend on it; it is kept separate from the required
 * command surface so its absence is explicit instead of a silent optional call.
 */
export interface SceneAcceptanceCapabilities {
  /** Simulate a real GPU device loss (only reachable through the ?perf bridge). */
  forceDeviceLoss(): void;
}

/** Browser-facing scene contract: required commands plus one idempotent lifetime. */
export interface ScenePort extends SceneCommands {
  readonly acceptance?: SceneAcceptanceCapabilities;
  mount(options: SceneMountOptions): Promise<SceneMountOutcome>;
  dispose(): void;
}
