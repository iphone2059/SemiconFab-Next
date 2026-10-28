import type { FabToolState } from '../domain/fab/fab-layout';

export interface FabPlacement { readonly fabId: string; readonly code: string; readonly position: readonly [number, number, number] }

export type SceneViewPreset = 'iso' | 'top' | 'reset' | 'focus' | 'litho' | 'airshower' | 'etch' | 'oht';
export type SceneLayer = 'amhs' | 'ceiling' | 'roof' | 'subfab' | 'heatmap' | 'airflow' | 'xray';
export type CutAxis = 'X' | 'Y' | 'Z';
export type XRayFilter = 'all' | 'upw' | 'gas' | 'vac' | 'exhaust' | 'amhs';

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

export interface SceneBackend {
  mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], signal: AbortSignal, onStatus: (status: string) => void, onToolPick?: (tool: PickedTool | null) => void, onAmhsStats?: (stats: AmhsStats) => void, onToolHover?: (hover: HoveredTool | null) => void, getToolStates?: () => readonly FabToolState[]): Promise<void>;
  dispose(): void;
  setView?(preset: SceneViewPreset, fabId?: string): void;
  setCameraPose?(position: readonly [number, number, number], target: readonly [number, number, number], durationMs: number): void;
  getCameraPose?(): { position: readonly [number, number, number]; target: readonly [number, number, number] } | null;
  zoom?(deltaY: number): void;
  resize?(): void;
  clearSelection?(): void;
  selectTool?(index: number, focus?: boolean): void;
  setLayer?(layer: SceneLayer, visible: boolean): void;
  setToolState?(index: number, state: FabToolState): void;
  setTour?(active: boolean): void;
  setExplodeFactor?(factor: number, modeActive?: boolean): void;
  setBasement?(active: boolean): void;
  setDual?(active: boolean): void;
  setCutPlane?(active: boolean, axis: CutAxis, position: number, invert: boolean): void;
  setXRayFilter?(filter: XRayFilter | null): void;
  setWaferPoint?(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void;
  setWaferTrail?(points: readonly (readonly [number, number, number])[]): void;
  focusPatrol?(): void;
  setLanguage?(language: 'zh' | 'en'): void;
}

export class SceneFacade {
  private readonly controller = new AbortController();
  constructor(private readonly backend: SceneBackend) {}
  async mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], onStatus: (status: string) => void, onToolPick?: (tool: PickedTool | null) => void, onAmhsStats?: (stats: AmhsStats) => void, onToolHover?: (hover: HoveredTool | null) => void, getToolStates?: () => readonly FabToolState[]): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      await this.backend.mount(canvas, fabs, this.controller.signal, status => { if (!this.controller.signal.aborted) onStatus(status); }, tool => { if (!this.controller.signal.aborted) onToolPick?.(tool); }, stats => { if (!this.controller.signal.aborted) onAmhsStats?.(stats); }, hover => { if (!this.controller.signal.aborted) onToolHover?.(hover); }, getToolStates);
      if (this.controller.signal.aborted) this.backend.dispose();
    } catch (error: unknown) {
      this.backend.dispose();
      if (!this.controller.signal.aborted) onStatus(error instanceof Error ? error.message : '场景初始化失败');
    }
  }
  setView(preset: SceneViewPreset, fabId?: string): void {
    if (!this.controller.signal.aborted) this.backend.setView?.(preset, fabId);
  }
  setCameraPose(position: readonly [number, number, number], target: readonly [number, number, number], durationMs: number): void {
    if (!this.controller.signal.aborted) this.backend.setCameraPose?.(position, target, durationMs);
  }
  getCameraPose(): { position: readonly [number, number, number]; target: readonly [number, number, number] } | null {
    return this.controller.signal.aborted ? null : this.backend.getCameraPose?.() ?? null;
  }
  zoom(deltaY: number): void {
    if (!this.controller.signal.aborted) this.backend.zoom?.(deltaY);
  }
  resize(): void {
    if (!this.controller.signal.aborted) this.backend.resize?.();
  }
  clearSelection(): void {
    if (!this.controller.signal.aborted) this.backend.clearSelection?.();
  }
  selectTool(index: number, focus?: boolean): void {
    if (!this.controller.signal.aborted) this.backend.selectTool?.(index, focus);
  }
  setLayer(layer: SceneLayer, visible: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setLayer?.(layer, visible);
  }
  setToolState(index: number, state: FabToolState): void {
    if (!this.controller.signal.aborted) this.backend.setToolState?.(index, state);
  }
  setTour(active: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setTour?.(active);
  }
  setExplodeFactor(factor: number, modeActive?: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setExplodeFactor?.(factor, modeActive);
  }
  setBasement(active: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setBasement?.(active);
  }
  setDual(active: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setDual?.(active);
  }
  setCutPlane(active: boolean, axis: CutAxis, position: number, invert: boolean): void {
    if (!this.controller.signal.aborted) this.backend.setCutPlane?.(active, axis, position, invert);
  }
  setXRayFilter(filter: XRayFilter | null): void {
    if (!this.controller.signal.aborted) this.backend.setXRayFilter?.(filter);
  }
  setWaferPoint(x: number, y: number, z: number, visible: boolean, focus: boolean, rotationY?: number): void {
    if (!this.controller.signal.aborted) this.backend.setWaferPoint?.(x, y, z, visible, focus, rotationY);
  }
  setWaferTrail(points: readonly (readonly [number, number, number])[]): void {
    if (!this.controller.signal.aborted) this.backend.setWaferTrail?.(points);
  }
  focusPatrol(): void {
    if (!this.controller.signal.aborted) this.backend.focusPatrol?.();
  }
  setLanguage(language: 'zh' | 'en'): void {
    if (!this.controller.signal.aborted) this.backend.setLanguage?.(language);
  }
  dispose(): void { this.controller.abort(); this.backend.dispose(); }
}
