/**
 * Fixed-capacity typed-array ring buffer for high-frequency frames. Writers use
 * Float32Array slots; renderers read the latest frame without touching React,
 * TanStack Query, Zustand or XState (ARCH-11). SharedArrayBuffer can back the
 * storage in a later Worker/COOP-COEP step; the public API only exposes copies.
 */
export interface FrameRingBufferOptions {
  readonly capacity?: number;
  readonly frameSize: number;
}

export class FrameRingBuffer {
  readonly capacity: number;
  readonly frameSize: number;
  private readonly storage: Float32Array;
  private head = -1;
  private available = 0;
  private nextSequence = 0;
  private dropped = 0;

  constructor(options: FrameRingBufferOptions) {
    if (!Number.isInteger(options.frameSize) || options.frameSize <= 0) throw new Error('frameSize must be a positive integer');
    const capacity = options.capacity ?? 512;
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('capacity must be a positive integer');
    this.capacity = capacity;
    this.frameSize = options.frameSize;
    this.storage = new Float32Array(capacity * options.frameSize);
  }

  /** Write one frame and return its monotonic sequence number. */
  write(values: ArrayLike<number>): number {
    if (values.length !== this.frameSize) throw new Error(`expected ${this.frameSize} values, got ${values.length}`);
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.head = (this.head + 1) % this.capacity;
    this.storage.set(values, this.head * this.frameSize);
    if (this.available < this.capacity) this.available += 1;
    else this.dropped += 1;
    return sequence;
  }

  /** Copy the latest frame into a caller-owned array (defaults to a new array). */
  readLatest(target?: Float32Array): Float32Array | undefined {
    if (this.head < 0) return undefined;
    const out = target ?? new Float32Array(this.frameSize);
    if (out.length !== this.frameSize) throw new Error('target length must equal frameSize');
    out.set(this.storage.subarray(this.head * this.frameSize, (this.head + 1) * this.frameSize));
    return out;
  }

  /** Copy a specific sequence if it is still retained. */
  read(sequence: number, target?: Float32Array): Float32Array | undefined {
    const oldest = this.nextSequence - this.available;
    if (sequence < oldest || sequence >= this.nextSequence) return undefined;
    const slot = sequence % this.capacity;
    const out = target ?? new Float32Array(this.frameSize);
    if (out.length !== this.frameSize) throw new Error('target length must equal frameSize');
    out.set(this.storage.subarray(slot * this.frameSize, (slot + 1) * this.frameSize));
    return out;
  }

  get latestSequence(): number {
    return this.nextSequence - 1;
  }

  get size(): number {
    return this.available;
  }

  get droppedFrames(): number {
    return this.dropped;
  }

  reset(): void {
    this.head = -1;
    this.available = 0;
    this.nextSequence = 0;
    this.dropped = 0;
    this.storage.fill(0);
  }
}
