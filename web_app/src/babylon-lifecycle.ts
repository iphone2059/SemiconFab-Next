export class InitializationDisposal {
  private pending = true;
  private requested = false;
  private released = false;
  constructor(private readonly release: () => void) {}
  private releaseWhenReady(): void {
    if (!this.pending && this.requested && !this.released) { this.released = true; this.release(); }
  }
  dispose(): void { this.requested = true; this.releaseWhenReady(); }
  settled(): void { this.pending = false; this.releaseWhenReady(); }
}

/** Device restore callbacks precede rendering. Acknowledge only completed GPU work. */
export class RecoveryFirstFrame {
  private epoch = 0;
  private restoreFrame = 0;
  private state: 'normal' | 'lost' | 'waiting' | 'submitted' | 'disposed' = 'normal';
  lost(): void { if (this.state !== 'disposed') { this.epoch++; this.state = 'lost'; } }
  restored(frameId = 0): void { if (this.state === 'lost') { this.restoreFrame = frameId; this.state = 'waiting'; } }
  get waiting(): boolean { return this.state === 'waiting'; }
  submitted(frameId: number, nativeResourcesReady: boolean, completion: Promise<void>, ready: () => void, failed: (error: unknown) => void): void {
    if (this.state !== 'waiting' || frameId <= this.restoreFrame || !nativeResourcesReady) return;
    const epoch = this.epoch;
    this.state = 'submitted';
    void completion.then(() => {
      if (this.epoch !== epoch || this.state !== 'submitted') return;
      this.state = 'normal'; ready();
    }, (error: unknown) => {
      if (this.epoch !== epoch || this.state !== 'submitted') return;
      this.state = 'lost'; failed(error);
    });
  }
  dispose(): void { this.epoch++; this.state = 'disposed'; }
}
