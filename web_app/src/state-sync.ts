export interface ScopeToken { readonly scope: string; readonly generation: number; readonly signal: AbortSignal }
export class ScopeGate {
  private current?: ScopeToken;
  private controller?: AbortController;
  private generation = 0;
  begin(scope: string): ScopeToken {
    this.dispose();
    this.controller = new AbortController();
    return this.current = { scope, generation: ++this.generation, signal: this.controller.signal };
  }
  accepts(token: ScopeToken): boolean { return this.current === token && !token.signal.aborted; }
  dispose(): void { this.controller?.abort(); this.current = undefined; }
}
