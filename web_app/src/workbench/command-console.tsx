import { useCommandProjection } from '@/app/runtime-provider';
import { Panel } from '@/workbench/panel';
import {
  COMMAND_ACTIONS,
  EQUIPMENT_IDS,
  useCommandConsole,
} from '@/workbench/use-command-console';

function ProjectionRow({ fabId, commandId }: { fabId: string; commandId: string }) {
  const projection = useCommandProjection(fabId, commandId);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', borderBottom: '1px solid var(--line, #1e293b)' }}>
      <code>{commandId.slice(0, 8)}</code>
      <span>{projection ? projection.recoveryDisposition === 'expired-unresolved' ? '结果不可确认' : `${projection.outcome} · rev ${projection.revision}` : '等待 SSE 事件…'}</span>
    </div>
  );
}

/**
 * Product command submission surface. HTTP submits the command, FabRuntime
 * tracks it, the backend SSE stream advances the XState workflow, and this
 * panel renders the read-only projection. Ownership is explicit:
 *  - useCommandConsole owns the submission ledger + idempotency key,
 *  - FabRuntime/useCommandProjection own the authoritative projection,
 *  - this component caches neither; re-renders always read the runtime.
 */
export function CommandConsole({ siteId, fabId }: { siteId: string; fabId: string }) {
  const console = useCommandConsole({ siteId, fabId });
  return (
    <Panel title="设备命令" subtitle="HTTP 提交 → SSE 命令流 → XState v6 工作流；本面板只读投影。刷新/断线恢复只保证活动命令（ADR-010 §6.6），终态历史请从运行历史/独立历史资源查看。">
      <form
        onSubmit={(event) => {
          void console.submit(event);
        }}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', marginBottom: 12 }}
      >
        <label>设备
          <select value={console.equipmentId} onChange={(event) => console.selectEquipment(event.target.value)}>
            {EQUIPMENT_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>动作
          <select value={console.action} onChange={(event) => console.selectAction(event.target.value)}>
            {COMMAND_ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit" className="ghost" disabled={console.busy || !console.runtime}>{console.busy ? '提交中…' : '下发命令'}</button>
      </form>
      {console.error && <div className="error" role="alert">{console.error}</div>}
      {console.tracked.length === 0
        ? <div className="empty">还没有命令。提交后，accepted → executing → succeeded 由后端模拟 SSE 推进。</div>
        : console.tracked.map((entry) => <ProjectionRow key={entry.commandId} fabId={entry.fabId} commandId={entry.commandId} />)}
    </Panel>
  );
}
