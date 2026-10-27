import type { CommandEventSource } from '../application/contracts/CommandEvents';
import type { CommandGateway } from '../application/contracts/CommandGateway';
import type { CommandWorkflowFactory, FabRuntimeRetentionOptions } from './FabRuntime';
import { FabRuntime } from './FabRuntime';

export interface FabRuntimeFactoryOptions {
  /** Per-FAB typed stream provider; the runtime never opens a transport itself. */
  readonly sourceFor: (fabId: string) => CommandEventSource;
  readonly gateway?: CommandGateway;
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the runtime defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
}

/** Creates one runtime per FAB from the same realtime source provider and gateway. */
export class FabRuntimeFactory {
  constructor(private readonly options: FabRuntimeFactoryOptions) {}

  create(fabId: string): FabRuntime {
    return new FabRuntime({
      fabId,
      source: this.options.sourceFor(fabId),
      gateway: this.options.gateway,
      createWorkflow: this.options.createWorkflow,
      retention: this.options.retention,
    });
  }
}
