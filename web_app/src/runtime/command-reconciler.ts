import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';

/**
 * Authoritative reconciliation: ask the backend for the command's current
 * status and feed one result into the workflow. This is the convergence path
 * after a disconnect or a missed WebSocket frame; the runtime decides when to
 * call it.
 */
export class CommandReconciler {
  constructor(private readonly gateway: CommandGateway) {}

  async reconcile(workflow: CommandWorkflow, fabId: string, commandId: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const event = await this.gateway.getCommandStatus(fabId, commandId);
    if (!event || !isCurrent()) return false;
    workflow.receive(event);
    return true;
  }
}
