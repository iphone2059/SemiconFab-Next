export interface FabPlacement { readonly fabId: string; readonly code: string; readonly position: readonly [number, number, number] }
export interface SceneBackend { mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], signal: AbortSignal, onStatus: (status: string) => void): Promise<void>; dispose(): void }
export class SceneFacade {
  private readonly controller = new AbortController();
  constructor(private readonly backend: SceneBackend) {}
  async mount(canvas: HTMLCanvasElement, fabs: readonly FabPlacement[], onStatus: (status: string) => void): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      await this.backend.mount(canvas, fabs, this.controller.signal, status => { if (!this.controller.signal.aborted) onStatus(status); });
      if (this.controller.signal.aborted) this.backend.dispose();
    } catch (error: unknown) {
      this.backend.dispose();
      if (!this.controller.signal.aborted) onStatus(error instanceof Error ? error.message : '场景初始化失败');
    }
  }
  dispose(): void { this.controller.abort(); this.backend.dispose(); }
}
