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
function sequenceValue(sequence: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) throw new Error('序号必须是无符号十进制字符串');
  const value = BigInt(sequence);
  if (value > 18446744073709551615n) throw new Error('序号超出 uint64');
  return value;
}
export class SequenceGate {
  private sequence?: bigint;
  snapshot(sequence: string): void { this.sequence = sequenceValue(sequence); }
  delta(sequence: string): 'accepted' | 'stale' | 'gap' {
    const value = sequenceValue(sequence);
    if (this.sequence === undefined) return 'gap';
    if (value <= this.sequence) return 'stale';
    if (value !== this.sequence + 1n) return 'gap';
    this.sequence = value;
    return 'accepted';
  }
}
// Development transport: complete HTTP snapshots only. No binary realtime stream.
export function startPolling<T>(query: (signal: AbortSignal) => Promise<T>, publish: (value: T) => void, fail: (error: unknown) => void, intervalMs = 1500): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll(): Promise<void> {
    try { const value = await query(controller.signal); if (!controller.signal.aborted) publish(value); }
    catch (error: unknown) { if (!controller.signal.aborted) fail(error); }
    if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, intervalMs);
  }
  void poll();
  return () => { controller.abort(); clearTimeout(timer); };
}
