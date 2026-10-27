export type SequenceDecision = 'in-order' | 'duplicate' | 'out-of-order' | 'gap';

export interface SequenceObservation {
  readonly decision: SequenceDecision;
  /** Expected next sequence when a gap was detected. */
  readonly expected?: number;
}

/**
 * Per-topic monotonic sequence gate. Realtime transports may redeliver or
 * reorder frames; the tracker only decides transport-level order, never
 * business-level dedupe (that stays in CommandEventBridge/ARCH-10).
 */
export class SequenceTracker {
  private readonly last = new Map<string, number>();

  observe(topic: string, sequence: number): SequenceObservation {
    const last = this.last.get(topic);
    if (last === undefined) {
      this.last.set(topic, sequence);
      return { decision: 'in-order' };
    }
    if (sequence === last) return { decision: 'duplicate' };
    if (sequence < last) return { decision: 'out-of-order' };
    if (sequence === last + 1) {
      this.last.set(topic, sequence);
      return { decision: 'in-order' };
    }
    this.last.set(topic, sequence);
    return { decision: 'gap', expected: last + 1 };
  }

  lastSequence(topic: string): number | undefined {
    return this.last.get(topic);
  }

  reset(): void {
    this.last.clear();
  }
}
