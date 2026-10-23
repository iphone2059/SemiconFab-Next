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
