import { useState, type FormEvent } from 'react';
import { submitEquipmentCommand } from '../../api/mutations/commands.mutations';
import { useCommandProjection, useFabRuntimeRegistry } from '../../app/providers/RuntimeProvider';
import { Panel } from '../../components/ui';

const EQUIPMENT_IDS = Array.from({ length: 16 }, (_, index) => `equipment-${index}`);
const ACTIONS = ['START', 'STOP', 'PAUSE'] as const;

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
 * panel renders the read-only projection.
 */
export function CommandConsole({ siteId, fabId }: { siteId: string; fabId: string }) {
  const registry = useFabRuntimeRegistry();
  const runtime = registry?.get(fabId);
  const [equipmentId, setEquipmentId] = useState(EQUIPMENT_IDS[0]);
  const [action, setAction] = useState<string>(ACTIONS[0]);
  const [tracked, setTracked] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!runtime) {
      setError('FAB 运行时尚未装配完成');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const submitted = await submitEquipmentCommand({ siteId, fabId, equipmentId, action });
      runtime.trackCommand(submitted.commandId);
      setTracked((previous) => [submitted.commandId, ...previous].slice(0, 8));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '命令提交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="设备命令" subtitle="HTTP 提交 → SSE 命令流 → XState v6 工作流；本面板只读投影。">
      <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', marginBottom: 12 }}>
        <label>设备
          <select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}>
            {EQUIPMENT_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>动作
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            {ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit" className="ghost" disabled={busy || !runtime}>{busy ? '提交中…' : '下发命令'}</button>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      {tracked.length === 0
        ? <div className="empty">还没有命令。提交后，accepted → executing → succeeded 由后端模拟 SSE 推进。</div>
        : tracked.map((commandId) => <ProjectionRow key={commandId} fabId={fabId} commandId={commandId} />)}
    </Panel>
  );
}
