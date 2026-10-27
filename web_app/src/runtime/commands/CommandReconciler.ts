import type { CommandGateway } from '../../application/contracts/CommandGateway';
import type { CommandWorkflow } from '../../application/contracts/CommandWorkflow';

/**
 * Authoritative reconciliation: ask the backend for the command's current
 * status and feed one result into the workflow. This is the convergence path
 * after a disconnect or a missed WebSocket frame; the runtime decides when to
 * call it.
 */
export class CommandReconciler {
  constructor(private readonly gateway: CommandGateway) {}

  async reconcile(workflow: CommandWorkflow, fabId: string, commandId: string): Promise<boolean> {
    const event = await this.gateway.getCommandStatus(fabId, commandId);
    if (!event) return false;
    workflow.receive(event);
    return true;
  }
}
