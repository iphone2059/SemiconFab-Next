import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { CommandWorkflowProjection } from '@/contracts/command-workflow.contract';

export type CommandProjectionAtom = Atom.Writable<CommandWorkflowProjection | undefined, CommandWorkflowProjection | undefined>;

/** Field equality: a value-equal projection must not notify React subscribers. */
function sameProjection(
  left: CommandWorkflowProjection | undefined,
  right: CommandWorkflowProjection | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.state === right.state && left.revision === right.revision && left.outcome === right.outcome;
}

export interface CommandProjectionStoreOptions {
  /** The AppRuntime registry: projections live in the same registry React reads. */
  readonly registry: AtomRegistry.AtomRegistry;
  /**
   * Hard cap on unpinned atoms (retained terminal projections + read-only atoms
   * created by the hook). Active command atoms are pinned by the FabRuntime and
   * never evicted (ADR-007 §6).
   */
  readonly maxRetained?: number;
}

/**
 * Bounded, per-FabRuntime store of read-only command projection Atoms. It
 * replaces the unbounded atom-family cache: FabRuntime is the only writer,
 * React reads with useAtomValue, and eviction/dispose invalidates the Atom value
 * so a stale projection can never be read by a later session.
 */
export class CommandProjectionStore {
  private readonly registry: AtomRegistry.AtomRegistry;
  private readonly maxRetained: number;
  private readonly atoms = new Map<string, CommandProjectionAtom>();
  /** Unpinned atoms holding a retained terminal projection (bounded, oldest first). */
  private readonly retained = new Set<string>();
  /** Active command atoms: owned by a live workflow, never eviction candidates. */
  private readonly pinned = new Set<string>();

  constructor(options: CommandProjectionStoreOptions) {
    this.registry = options.registry;
    this.maxRetained = Math.max(1, options.maxRetained ?? 128);
  }

  /** Stable Atom identity for one command; created on first read/write. */
  atomFor(commandId: string): CommandProjectionAtom {
    const existing = this.atoms.get(commandId);
    if (existing) return existing;
    const atom = Atom.make<CommandWorkflowProjection | undefined>(undefined);
    this.atoms.set(commandId, atom);
    this.enforceBounds();
    return atom;
  }

  getAtom(commandId: string): CommandProjectionAtom | undefined {
    return this.atoms.get(commandId);
  }

  /** The only write path; value-equal publishes are dropped to avoid React churn. */
  set(commandId: string, projection: CommandWorkflowProjection): void {
    const atom = this.atomFor(commandId);
    if (sameProjection(this.registry.get(atom), projection)) return;
    this.registry.set(atom, projection);
  }

  /** The current store value (last written projection) without touching the workflow. */
  peek(commandId: string): CommandWorkflowProjection | undefined {
    const atom = this.atoms.get(commandId);
    return atom ? this.registry.get(atom) : undefined;
  }

  /** Bind the atom to a live workflow: it may not be evicted until unpinned. */
  pin(commandId: string): void {
    this.pinned.add(commandId);
    this.retained.delete(commandId);
  }

  /** Keep the terminal projection readable after eviction, inside the bounded set. */
  retain(commandId: string, projection: CommandWorkflowProjection): void {
    this.pinned.delete(commandId);
    const atom = this.atomFor(commandId);
    if (!sameProjection(this.registry.get(atom), projection)) this.registry.set(atom, projection);
    this.retained.delete(commandId);
    this.retained.add(commandId);
    this.enforceBounds();
  }

  /** Drop one command's projection: the Atom is invalidated, never left stale. */
  forget(commandId: string): void {
    const atom = this.atoms.get(commandId);
    this.atoms.delete(commandId);
    this.pinned.delete(commandId);
    this.retained.delete(commandId);
    if (atom) this.registry.set(atom, undefined);
  }

  /** Invalidate every projection on FAB/runtime teardown (no old value is readable). */
  invalidateAll(): void {
    for (const atom of this.atoms.values()) this.registry.set(atom, undefined);
    this.atoms.clear();
    this.pinned.clear();
    this.retained.clear();
  }

  get size(): number {
    return this.atoms.size;
  }

  get retainedCount(): number {
    return this.retained.size;
  }

  get pinnedCount(): number {
    return this.pinned.size;
  }

  private enforceBounds(): void {
    const excess = (): boolean => this.atoms.size - this.pinned.size > this.maxRetained;
    // Prefer evicting throwaway atoms created by a read for a command that has no
    // retained terminal value; retained terminal projections go last.
    for (const commandId of [...this.atoms.keys()]) {
      if (!excess()) return;
      if (this.pinned.has(commandId) || this.retained.has(commandId)) continue;
      this.forget(commandId);
    }
    for (const commandId of [...this.retained]) {
      if (!excess()) return;
      if (this.pinned.has(commandId)) continue;
      this.forget(commandId);
    }
  }
}
