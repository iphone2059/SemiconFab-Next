import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { submitEquipmentCommand } from '@/api/commands.mutation';
import { createEquipmentCommandIdempotencyKey } from '@/api/command.schema';
import { useAppRuntime } from '@/app/app-runtime-provider';
import { useFabRuntimeRegistry } from '@/app/runtime-provider';
import type { FabRuntimeRegistry } from '@/runtime/fab-runtime-registry';

export const EQUIPMENT_IDS = Array.from({ length: 16 }, (_, index) => `equipment-${index}`);
export const COMMAND_ACTIONS = ['START', 'STOP', 'PAUSE'] as const;

/** A tracked command remembers the FAB that accepted it, so its projection row can
 * never query another FAB's runtime after an in-place scope switch. */
export interface TrackedCommand {
  readonly commandId: string;
  readonly fabId: string;
}

/** One pending idempotency key, bound to the full command identity it was minted for. */
interface PendingKey {
  readonly identity: string;
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

/** Composite token identifying the FAB lifetime of the console. */
const scopeOf = (siteId: string, fabId: string): string => JSON.stringify([siteId, fabId]);

export interface CommandConsoleController {
  runtime: ReturnType<FabRuntimeRegistry['get']>;
  equipmentId: string;
  action: string;
  busy: boolean;
  error: string;
  /** Submission ledger (command ids) only; projections are read from the runtime. */
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
 * submission ledger (which command ids this console sent) plus the retry
 * idempotency key. It never mirrors a projection/outcome value, so no parallel
 * command cache exists beside the runtime.
 */
export function useCommandConsole({ siteId, fabId }: { siteId: string; fabId: string }): CommandConsoleController {
  const registry = useFabRuntimeRegistry();
  const appRuntime = useAppRuntime();
  const runtime = registry?.get(fabId);
  const [equipmentId, setEquipmentId] = useState(EQUIPMENT_IDS[0]);
  const [action, setAction] = useState<string>(COMMAND_ACTIONS[0]);
  const scope = scopeOf(siteId, fabId);
  // Render-time refs let a submission continuation detect a replaced scope or an
  // unmounted console without adding per-render objects to the async formula.
  const scopeRef = useRef(scope);
  useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  const aliveRef = useRef(true);
  // Layout-effect cleanup runs synchronously on unmount, before a late promise
  // reaction can reach setStored/runtime.trackCommand.
  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const [stored, setStored] = useState(() => createConsoleState(scope));
  let state = stored;
  if (state.scope !== scope) {
    // Reset during render (React's "adjust state when a prop changes" pattern):
    // the new FAB must never paint or act on the previous FAB's console state.
    state = createConsoleState(scope);
    setStored(state);
  }
  const update = (mutate: (previous: ConsoleState) => ConsoleState) => {
    setStored((previous) => mutate(previous.scope === scope ? previous : createConsoleState(scope)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runtime) {
      update((previous) => ({ ...previous, error: 'FAB 运行时尚未装配完成' }));
      return;
    }
    const submittedScope = scope;
    const isCurrentScope = () => aliveRef.current && scopeRef.current === submittedScope;
    // Reuse the key only while retrying the exact same logical command; any
    // other component change resets it (the select handlers below do too).
    const identity = JSON.stringify([siteId, fabId, equipmentId, action]);
    const idempotencyKey = state.pendingKey?.identity === identity
      ? state.pendingKey.key
      : createEquipmentCommandIdempotencyKey();
    update((previous) => ({ ...previous, busy: true, error: '', pendingKey: { identity, key: idempotencyKey } }));
    try {
      const submitted = await appRuntime.runPromise(submitEquipmentCommand({ siteId, fabId, equipmentId, action, idempotencyKey }));
      // A completion for a replaced scope must not enter the new FAB's page, its
      // tracked list, or its runtime.
      if (!isCurrentScope()) return;
      runtime.trackCommand(submitted.commandId);
      update((previous) => ({
        ...previous,
        // The validated response echoes the submitted FAB identity (cross-FAB responses throw).
        tracked: [{ commandId: submitted.commandId, fabId: submitted.fabId }, ...previous.tracked].slice(0, 8),
        pendingKey: null,
      }));
    } catch (cause) {
      if (!isCurrentScope()) return;
      update((previous) => ({ ...previous, error: cause instanceof Error ? cause.message : '命令提交失败' }));
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
