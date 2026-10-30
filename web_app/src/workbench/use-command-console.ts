import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { submitEquipmentCommand } from '@/api/commands.mutation';
import { createEquipmentCommandIdempotencyKey } from '@/api/command.schema';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { useFabRuntimeRegistry } from '@/app/runtime-provider';
import { fabIdentityKey, type FabIdentity } from '@/domain/fab-identity';
import type { AcceptedCommandRegistration, FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';
import type { CommandAdmissionReservation } from '@/runtime/fab-runtime';
import { HttpFailure, IdempotencyConflict, InvalidRequest } from '@/api/http.transport';

export const EQUIPMENT_IDS = Array.from({ length: 16 }, (_, index) => `equipment-${index}`);
export const COMMAND_ACTIONS = ['START', 'STOP', 'PAUSE'] as const;

/**
 * R5.4-02: how the backend-accepted (HTTP 202) command id reached the runtime
 * registry. Both values are "accepted": a recovery-pending row keeps its tracked
 * command id and renders the runtime-waiting state, never a rejection.
 */
export type CommandHandoff = 'registered' | 'recovery-pending';

/** A tracked command remembers the full FAB identity that accepted it, so its
 * projection row can never query another site's runtime after an in-place scope
 * switch (siteId and fabId are both part of the console lifetime). */
export interface TrackedCommand {
  readonly siteId: string;
  readonly fabId: string;
  readonly commandId: string;
  readonly handoff: CommandHandoff;
}

/** One pending idempotency key, bound to the full command identity it was minted for. */
interface PendingKey {
  readonly signature: string;
  readonly key: string;
}

/**
 * Console state belongs to one composite (siteId, fabId) lifetime. Storing the
 * scope beside it lets a prop change reset tracked/pendingKey/busy/error during
 * render, before any async completion of the previous FAB can be observed.
 */
interface ConsoleState {
  readonly scope: string;
  readonly tracked: readonly TrackedCommand[];
  readonly error: string;
  readonly busy: boolean;
  readonly pendingKey: PendingKey | null;
}

const createConsoleState = (scope: string): ConsoleState => ({
  scope,
  tracked: [],
  error: '',
  busy: false,
  pendingKey: null,
});

/** Composite token identifying the FAB lifetime of the console (collision-free key). */
const scopeOf = (identity: FabIdentity): string => fabIdentityKey(identity);

export interface CommandConsoleController {
  runtime: ReturnType<FabRuntimeRegistry['get']>;
  equipmentId: string;
  action: string;
  busy: boolean;
  error: string;
  /** Submission ledger (full identity + command id + handoff) only; projections are read from the runtime. */
  tracked: readonly TrackedCommand[];
  selectEquipment: (equipmentId: string) => void;
  selectAction: (action: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

/**
 * Command submission controller.
 *
 * The authoritative workflow projection stays in the FAB runtime and is read
 * per row with `useCommandProjection`; this hook keeps only the immutable
 * submission ledger (full composite identity, command ids and their handoff
 * kind) plus the retry idempotency key. It never mirrors a projection/outcome
 * value, so no parallel command cache exists beside the runtime.
 *
 * R5.4-02: after the HTTP 202 the registry returns whether the command id was
 * registered on the current runtime or retained for the next generation. Both
 * mean accepted; a recovery-pending id stays tracked (so a 202 is never lost)
 * and is not rendered as a failure.
 *
 * Session scope (ADR-010 §6.6 / R3-11 decision A): the ledger is never persisted.
 * Browser refresh/SSE reconnect recovery guarantees **active** commands only;
 * terminal history is not restored from this ledger and must be read from the
 * independent history resource (runs/results or a future command-history API).
 */
export function useCommandConsole({ siteId, fabId }: { siteId: string; fabId: string }): CommandConsoleController {
  const registry = useFabRuntimeRegistry();
  const appRuntime = useAppRuntime();
  const identity: FabIdentity = { siteId, fabId };
  const runtime = registry?.get(identity);
  const [equipmentId, setEquipmentId] = useState(EQUIPMENT_IDS[0]);
  const [action, setAction] = useState<string>(COMMAND_ACTIONS[0]);
  const scope = scopeOf(identity);
  // Render-time refs let a submission continuation detect a replaced scope or an
  // unmounted console without adding per-render objects to the async formula.
  const scopeRef = useRef(scope);
  useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  const aliveRef = useRef(true);
  // Layout-effect cleanup runs synchronously on unmount, before a late promise
  // reaction can reach setStored/registry.registerAcceptedCommand.
  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const [stored, setStored] = useState(() => createConsoleState(scope));
  let state = stored;
  if (state.scope !== scope) {
    // Reset during render (React's "adjust state when a prop changes" pattern):
    // the new composite (siteId, fabId) must never paint or act on the previous
    // FAB's console state.
    state = createConsoleState(scope);
    setStored(state);
  }
  const update = (mutate: (previous: ConsoleState) => ConsoleState) => {
    setStored((previous) => mutate(previous.scope === scope ? previous : createConsoleState(scope)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.busy) return;
    if (!runtime) {
      update((previous) => ({ ...previous, error: 'FAB 运行时尚未装配完成' }));
      return;
    }
    const submittedScope = scope;
    const submittedIdentity: FabIdentity = { siteId, fabId };
    const isCurrentScope = () => aliveRef.current && scopeRef.current === submittedScope;
    // Reuse the key only while retrying the exact same logical command; any
    // other component change resets it (the select handlers below do too).
    const signature = JSON.stringify([siteId, fabId, equipmentId, action]);
    const idempotencyKey = state.pendingKey?.signature === signature
      ? state.pendingKey.key
      : createEquipmentCommandIdempotencyKey();
    update((previous) => ({ ...previous, busy: true, error: '', pendingKey: { signature, key: idempotencyKey } }));
    let reservation: CommandAdmissionReservation | undefined;
    try {
      reservation = runtime.reserveCommandAdmission(idempotencyKey);
      const submitted = await appRuntime.runPromise(submitEquipmentCommand({ siteId, fabId, equipmentId, action, idempotencyKey }));
      // R5.4-02: hand the accepted command id to the current runtime generation.
      // 'recovery-pending' is still an acceptance: the id is retained by the
      // registry until a runtime adopts it, and this console keeps tracking it.
      const registration: AcceptedCommandRegistration = registry?.registerAcceptedCommand(
        submittedIdentity,
        submitted.commandId,
        reservation,
      ) ?? { kind: 'registered' };
      if (!isCurrentScope()) return;
      update((previous) => ({
        ...previous,
        // The validated response echoes the submitted FAB identity (cross-FAB responses throw).
        tracked: [{
          siteId: submitted.siteId,
          fabId: submitted.fabId,
          commandId: submitted.commandId,
          handoff: registration.kind,
        }, ...previous.tracked].slice(0, 8),
        pendingKey: null,
      }));
    } catch (cause) {
      // The registry owns the accepted-id handoff; this path only returns a
      // submission-time reservation. A released/committed reservation is never
      // released a second time.
      if (reservation?.state === 'reserved') reservation.release();
      const rejected = cause instanceof InvalidRequest || cause instanceof IdempotencyConflict ||
        (cause instanceof HttpFailure && cause.status >= 400 && cause.status < 500);
      if (!rejected && reservation !== undefined) registry?.requestAuthoritativeRecovery(submittedIdentity);
      if (!isCurrentScope()) return;
      update((previous) => ({ ...previous, error: cause instanceof Error ? cause.message : '命令提交失败', ...(rejected ? { pendingKey: null } : {}) }));
    } finally {
      if (isCurrentScope()) update((previous) => ({ ...previous, busy: false }));
    }
  };

  return {
    runtime,
    equipmentId,
    action,
    busy: state.busy,
    error: state.error,
    tracked: state.tracked,
    selectEquipment: (next: string) => {
      setEquipmentId(next);
      update((previous) => ({ ...previous, pendingKey: null }));
    },
    selectAction: (next: string) => {
      setAction(next);
      update((previous) => ({ ...previous, pendingKey: null }));
    },
    submit,
  };
}
