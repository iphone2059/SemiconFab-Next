import type { Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandWorkflowFactory, FabRuntimeRetentionOptions } from '@/runtime/fab-runtime';
import { FabRuntime } from '@/runtime/fab-runtime';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

export interface FabRuntimeFactoryOptions {
  /** Approved execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** AppScope: each FabRuntime forks its own FabScope from it. */
  readonly parentScope: Scope.Scope;
  /** Required single projection registry (AppRuntime.registry in production). */
  readonly projectionRegistry: AtomRegistry.AtomRegistry;
  /** Per-FAB typed source provider; receives the FAB's CommandTransportScope. */
  readonly sourceFor: (fabId: string, scope: Scope.Scope) => CommandEventSource;
  readonly gateway?: CommandGateway;
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the runtime defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
  /** Defer opening the per-FAB command SSE stream until a command is tracked. */
  readonly lazyCommandSubscription?: boolean;
  readonly maxConcurrentReconciliations?: number;
  readonly maxQueuedReconciliations?: number;
  readonly reconcileTimeoutMs?: number;
}

/** Creates one runtime per (siteId, fabId) from the same scopes/source provider/gateway. */
export class FabRuntimeFactory {
  constructor(private readonly options: FabRuntimeFactoryOptions) {}

  create(fabId: string, siteId: string): FabRuntime {
    return new FabRuntime({
      siteId,
      fabId,
      runtime: this.options.runtime,
      parentScope: this.options.parentScope,
      projectionRegistry: this.options.projectionRegistry,
      sourceFor: this.options.sourceFor,
      gateway: this.options.gateway,
      createWorkflow: this.options.createWorkflow,
      retention: this.options.retention,
      lazyCommandSubscription: this.options.lazyCommandSubscription,
      maxConcurrentReconciliations: this.options.maxConcurrentReconciliations,
      maxQueuedReconciliations: this.options.maxQueuedReconciliations,
      reconcileTimeoutMs: this.options.reconcileTimeoutMs,
    });
  }
}
