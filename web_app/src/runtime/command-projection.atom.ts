import * as Atom from 'effect/reactivity/Atom';
import type { CommandWorkflowProjection } from '@/contracts/command-workflow.contract';

/** Deterministic atom key: one read-only projection per (fabId, commandId). */
export const commandProjectionKey = (fabId: string, commandId: string): string =>
  fabId + '\u0000' + commandId;

/**
 * The read-only Atom projection of one command's XState workflow. FabRuntime is
 * the only writer (inside afterDelivery/trackCommand); React reads it with
 * useAtomValue. The actor context is never copied into another cache.
 */
export const commandProjectionAtom = Atom.family((_key: string) =>
  Atom.make<CommandWorkflowProjection | undefined>(undefined),
);
