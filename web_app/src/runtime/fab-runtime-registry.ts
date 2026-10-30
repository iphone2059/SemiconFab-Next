import { fabIdentityKey, type FabIdentity } from '@/domain/fab-identity';
import type { CommandAdmissionReservation, FabRuntime } from '@/runtime/fab-runtime';

/**
 * R5.4-02 outcome of handing one backend-accepted (HTTP 202) command to the
 * registry. Both kinds mean "accepted": the command id stays tracked by the
 * console either way, so a 202 can never be rendered as a failure.
 */
export type AcceptedCommandRegistration =
  | { readonly kind: 'registered' }
  | { readonly kind: 'recovery-pending' };

/**
 * Commands accepted by the backend for one composite identity that no current
 * runtime has accepted yet. Only the identity and command ids are retained: no
 * payload, workflow, actor, reservation or runtime copy ever leaks across a
 * runtime replacement.
 */
interface PendingAcceptedCommands {
  readonly identity: FabIdentity;
  readonly commandIds: Set<string>;
}

/**
 * Composite-keyed FAB runtime registry (ADR-007 §3, R5.4-03).
 *
 * One runtime per (siteId, fabId): every Map/Set key is produced by
 * fabIdentityKey(), so the same fabId in two Sites can never collide and no site
 * is ever inferred from a bare fabId.
 *
 * R5.4-02 accepted-command handoff: an HTTP 202 may arrive after the runtime that
 * reserved the admission was replaced or disposed. The registry hands the
 * command id to the current runtime, or retains it in a pending set (with an
 * optional coalesced authoritative-recovery intent) until a later generation
 * registers. A command id is removed from pending only after a runtime accepted
 * it; pending state survives disposeAll() and there is no TTL and no silent drop.
 */
export class FabRuntimeRegistry {
  private readonly runtimes = new Map<string, FabRuntime>();
  private readonly pendingAcceptedCommands = new Map<string, PendingAcceptedCommands>();
  /** Coalesced per identity: a missing runtime records one recovery intent, not one per command. */
  private readonly pendingAuthoritativeRecovery = new Map<string, FabIdentity>();

  /** Read-only evidence: accepted command ids still awaiting a current runtime. */
  get pendingHandoffCount(): number {
    let count = 0;
    for (const pending of this.pendingAcceptedCommands.values()) count += pending.commandIds.size;
    return count;
  }

  register(runtime: FabRuntime): void {
    const identity: FabIdentity = { siteId: runtime.siteId, fabId: runtime.fabId };
    const key = fabIdentityKey(identity);
    if (this.runtimes.has(key)) {
      throw new Error('FAB runtime already registered: ' + identity.siteId + '/' + identity.fabId);
    }
    this.runtimes.set(key, runtime);
    // Case D: a new generation adopts every command id accepted while it was absent.
    this.handoffPending(identity, runtime);
  }

  get(identity: FabIdentity): FabRuntime | undefined {
    return this.runtimes.get(fabIdentityKey(identity));
  }

  remove(identity: FabIdentity): FabRuntime | undefined {
    const key = fabIdentityKey(identity);
    const runtime = this.runtimes.get(key);
    if (!runtime) return undefined;
    runtime.dispose();
    this.runtimes.delete(key);
    return runtime;
  }

  /**
   * Hand one accepted command id (HTTP 202) to the current runtime (cases A/B/C).
   *
   * A: the current runtime still owns the reservation -> commit (single workflow,
   *    no second admission check).
   * B: the reservation belongs to a replaced runtime -> the current runtime
   *    registers the id; the old reservation is released only afterwards and only
   *    while still reserved. If the current runtime rejects the id, it is retained
   *    in pending state instead of being dropped.
   * C: no runtime -> retain the id in pending state; never commit and never create
   *    a detached workflow.
   */
  registerAcceptedCommand(
    identity: FabIdentity,
    commandId: string,
    reservation: CommandAdmissionReservation,
  ): AcceptedCommandRegistration {
    if (reservation.siteId !== identity.siteId || reservation.fabId !== identity.fabId) {
      throw new Error(
        'accepted command reservation identity mismatch: ' + reservation.siteId + '/' + reservation.fabId +
        ' vs ' + identity.siteId + '/' + identity.fabId,
      );
    }
    const runtime = this.get(identity);
    if (runtime !== undefined && runtime.ownsReservation(reservation)) {
      reservation.commit(commandId);
      return { kind: 'registered' };
    }
    if (runtime !== undefined) {
      try {
        runtime.registerAcceptedCommand(commandId);
      } catch {
        // The current runtime refused the id (e.g. disposed mid-flight): retain it
        // for the next generation and release the stale reservation; the 202 is
        // never lost and never becomes a detached workflow.
        this.retainPendingAcceptedCommand(identity, commandId);
        this.releaseReservation(reservation);
        return { kind: 'recovery-pending' };
      }
      this.releaseReservation(reservation);
      return { kind: 'registered' };
    }
    this.retainPendingAcceptedCommand(identity, commandId);
    this.releaseReservation(reservation);
    return { kind: 'recovery-pending' };
  }

  /**
   * Record the intent to run one authoritative recovery pass for this identity.
   * With a current runtime the intent is executed immediately; without one it is
   * retained (coalesced per identity) and executed on the next register().
   */
  requestAuthoritativeRecovery(identity: FabIdentity): void {
    const runtime = this.get(identity);
    if (runtime !== undefined) {
      runtime.requestAuthoritativeRecovery();
      return;
    }
    this.pendingAuthoritativeRecovery.set(fabIdentityKey(identity), identity);
  }

  startAll(): void {
    for (const runtime of this.runtimes.values()) runtime.start();
  }

  stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop();
  }

  /**
   * Case E: dispose every runtime and clear the runtime map, but retain all
   * pending handoff state. Pending command ids are removed only after a later
   * generation accepts them; there is no TTL and no silent drop.
   */
  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  get size(): number {
    return this.runtimes.size;
  }

  get fabIdentities(): readonly FabIdentity[] {
    return [...this.runtimes.values()].map((runtime) => ({ siteId: runtime.siteId, fabId: runtime.fabId }));
  }

  private retainPendingAcceptedCommand(identity: FabIdentity, commandId: string): void {
    const key = fabIdentityKey(identity);
    const pending = this.pendingAcceptedCommands.get(key);
    if (pending !== undefined) {
      // Idempotent duplicate handoff: the Set retains one id per command.
      pending.commandIds.add(commandId);
      return;
    }
    this.pendingAcceptedCommands.set(key, { identity, commandIds: new Set([commandId]) });
  }

  /** Case D: flush retained command ids, then the coalesced recovery intent. */
  private handoffPending(identity: FabIdentity, runtime: FabRuntime): void {
    const key = fabIdentityKey(identity);
    const pending = this.pendingAcceptedCommands.get(key);
    if (pending !== undefined) {
      for (const commandId of [...pending.commandIds]) {
        try {
          runtime.registerAcceptedCommand(commandId);
        } catch {
          // Retained: a later generation may still accept it.
          continue;
        }
        pending.commandIds.delete(commandId);
      }
      if (pending.commandIds.size === 0) this.pendingAcceptedCommands.delete(key);
    }
    if (this.pendingAuthoritativeRecovery.has(key)) {
      try {
        runtime.requestAuthoritativeRecovery();
      } catch {
        return;
      }
      this.pendingAuthoritativeRecovery.delete(key);
    }
  }

  /** Release only a reservation that is still ours to release; never release twice. */
  private releaseReservation(reservation: CommandAdmissionReservation): void {
    if (reservation.state === 'reserved') reservation.release();
  }
}
