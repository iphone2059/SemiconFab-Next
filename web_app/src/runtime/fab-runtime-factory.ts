import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandWorkflowFactory, FabRuntimeRetentionOptions } from '@/runtime/fab-runtime';
import { FabRuntime } from '@/runtime/fab-runtime';

export interface FabRuntimeFactoryOptions {
  /** Per-FAB typed stream provider; the runtime never opens a transport itself. */
  readonly sourceFor: (fabId: string) => CommandEventSource;
  readonly gateway?: CommandGateway;
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the runtime defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
  /** Defer opening the per-FAB command SSE stream until a command is tracked. */
  readonly lazyCommandSubscription?: boolean;
  readonly projectionRegistry?: AtomRegistry.AtomRegistry;
  readonly maxConcurrentReconciliations?: number;
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
      lazyCommandSubscription: this.options.lazyCommandSubscription,
      projectionRegistry: this.options.projectionRegistry,
      maxConcurrentReconciliations: this.options.maxConcurrentReconciliations,
    });
  }
}
