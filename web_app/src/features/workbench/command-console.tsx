import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { submitEquipmentCommand } from '../../api/mutations/commands.mutations';
import { createEquipmentCommandIdempotencyKey } from '../../api/schemas/command.schema';
import { useCommandProjection, useFabRuntimeRegistry } from '../../app/providers/RuntimeProvider';
import { Panel } from '../../components/ui';

const EQUIPMENT_IDS = Array.from({ length: 16 }, (_, index) => `equipment-${index}`);
const ACTIONS = ['START', 'STOP', 'PAUSE'] as const;

/** A tracked command remembers the FAB that accepted it, so its projection row can
 * never query another FAB's runtime after an in-place scope switch. */
interface TrackedCommand {
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

const createConsoleState = (scope: string): ConsoleState => ({ scope, tracked: [], error: '', busy: false, pendingKey: null });

/** Composite token identifying the FAB lifetime of the console. */
const scopeOf = (siteId: string, fabId: string): string => JSON.stringify([siteId, fabId]);

function ProjectionRow({ fabId, commandId }: { fabId: string; commandId: string }) {
  const projection = useCommandProjection(fabId, commandId);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', borderBottom: '1px solid var(--line, #1e293b)' }}>
      <code>{commandId.slice(0, 8)}</code>
      <span>{projection ? `${projection.outcome} · rev ${projection.revision}` : '等待 SSE 事件…'}</span>
    </div>
  );
}

/**
 * Product command submission surface. HTTP submits the command, FabRuntime
 * tracks it, the backend SSE stream advances the XState workflow, and this
 * panel renders the read-only projection. Requests, history and the idempotency
 * key are bound to the composite (siteId, fabId) lifetime.
 */
export function CommandConsole({ siteId, fabId }: { siteId: string; fabId: string }) {
  const registry = useFabRuntimeRegistry();
  const runtime = registry?.get(fabId);
  const [equipmentId, setEquipmentId] = useState(EQUIPMENT_IDS[0]);
  const [action, setAction] = useState<string>(ACTIONS[0]);
  const scope = scopeOf(siteId, fabId);
  // Render-time refs let a submission continuation detect a replaced scope or an
  // unmounted console without adding per-render objects to the async formula.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
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

  const submit = async (event: FormEvent) => {
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
      const submitted = await submitEquipmentCommand({ siteId, fabId, equipmentId, action, idempotencyKey });
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

  return (
    <Panel title="设备命令" subtitle="HTTP 提交 → SSE 命令流 → XState v6 工作流；本面板只读投影。">
      <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', marginBottom: 12 }}>
        <label>设备
          <select value={equipmentId} onChange={(event) => { setEquipmentId(event.target.value); update((previous) => ({ ...previous, pendingKey: null })); }}>
            {EQUIPMENT_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>动作
          <select value={action} onChange={(event) => { setAction(event.target.value); update((previous) => ({ ...previous, pendingKey: null })); }}>
            {ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit" className="ghost" disabled={state.busy || !runtime}>{state.busy ? '提交中…' : '下发命令'}</button>
      </form>
      {state.error && <div className="error" role="alert">{state.error}</div>}
      {state.tracked.length === 0
        ? <div className="empty">还没有命令。提交后，accepted → executing → succeeded 由后端模拟 SSE 推进。</div>
        : state.tracked.map((entry) => <ProjectionRow key={entry.commandId} fabId={entry.fabId} commandId={entry.commandId} />)}
    </Panel>
  );
}
