import type { Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { CommandEventSource } from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { FabIdentity } from '@/domain/fab-identity';
import type {
  CommandWorkflowFactory,
  FabRuntimeRecoveryOptions,
  FabRuntimeRetentionOptions,
} from '@/runtime/fab-runtime';
import { FabRuntime } from '@/runtime/fab-runtime';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

export interface FabRuntimeFactoryOptions {
  /** Approved execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** AppScope: each FabRuntime forks its own FabScope from it. */
  readonly parentScope: Scope.Scope;
  /** Required single projection registry (AppRuntime.registry in production). */
  readonly projectionRegistry: AtomRegistry.AtomRegistry;
  /** Per-FAB typed source provider; receives the complete identity and CommandTransportScope. */
  readonly sourceFor: (identity: FabIdentity, scope: Scope.Scope) => CommandEventSource;
  /**
   * R3-07: REQUIRED explicit recovery authority (same contract as
   * FabRuntimeOptions.gateway). Pass the authoritative CommandGateway, or
   * `undefined` to declare an explicitly display-only runtime; forgetting the
   * property is a compile-time error at the composition root. A display-only
   * runtime is observable as Unavailable and can never report Healthy.
   */
  readonly gateway: CommandGateway | undefined;
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the runtime defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
  /** ADR-010 §4 recovery state machine bounds/backoff (test seam; production defaults). */
  readonly recovery?: FabRuntimeRecoveryOptions;
  /** Defer opening the per-FAB command SSE stream until a command is tracked. */
  readonly lazyCommandSubscription?: boolean;
  readonly maxConcurrentReconciliations?: number;
  readonly maxQueuedReconciliations?: number;
  readonly reconcileTimeoutMs?: number;
  /** R4-08: hard active-command admission bound (mirrors backend MaxActiveCommandsPerFab). */
  readonly maxActiveCommands?: number;
}

/** Creates one runtime per (siteId, fabId) from the same scopes/source provider/gateway. */
export class FabRuntimeFactory {
  constructor(private readonly options: FabRuntimeFactoryOptions) {}

  create(identity: FabIdentity): FabRuntime {
    return new FabRuntime({
      siteId: identity.siteId,
      fabId: identity.fabId,
      runtime: this.options.runtime,
      parentScope: this.options.parentScope,
      projectionRegistry: this.options.projectionRegistry,
      sourceFor: this.options.sourceFor,
      gateway: this.options.gateway,
      createWorkflow: this.options.createWorkflow,
      retention: this.options.retention,
      recovery: this.options.recovery,
      lazyCommandSubscription: this.options.lazyCommandSubscription,
      maxConcurrentReconciliations: this.options.maxConcurrentReconciliations,
      maxQueuedReconciliations: this.options.maxQueuedReconciliations,
      reconcileTimeoutMs: this.options.reconcileTimeoutMs,
      maxActiveCommands: this.options.maxActiveCommands,
    });
  }
}
