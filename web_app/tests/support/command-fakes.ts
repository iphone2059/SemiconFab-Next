import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from 'effect';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandEventSource,
  CommandOutcome,
  CommandResultEvent,
  CommandStreamDirty,
  CommandStreamGap,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import type {
  CommandGateway,
  CommandJournalEvent,
  CommandJournalPage,
  CommandJournalQuery,
  CommandRecoveryFilter,
  CommandRecoveryList,
  CommandRecoveryRecord,
} from '@/contracts/command-gateway.contract';
import type { CommandWorkflow, CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';
import type { CommandWorkflowFactory, FabRuntimeRetentionOptions } from '@/runtime/fab-runtime';
import { FabRuntime } from '@/runtime/fab-runtime';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

export class FakeCommandWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];
  readonly reconciled: string[] = [];
  disposed = false;

  receive(event: CommandResultEvent): void {
    this.events.push(event);
  }

  async reconcile(commandId: string): Promise<void> {
    this.reconciled.push(commandId);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Counting workflow used by finalizer/eviction tests without XState overhead. */
export class CountingCommandWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];
  private revision = -1;
  private outcome: CommandOutcome | 'pending' = 'pending';
  disposeCalls = 0;

  constructor(readonly fabId: string, readonly commandId: string) {}

  receive(event: CommandResultEvent): void {
    if (event.revision <= this.revision) return;
    this.revision = event.revision;
    this.outcome = event.outcome;
  }

  async reconcile(): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
  }

  get projection(): { state: string; revision: number; outcome: CommandOutcome | 'pending' } {
    return {
      state: this.outcome === 'pending' ? 'idle' : this.outcome,
      revision: this.revision,
      outcome: this.outcome,
    };
  }
}

export class FakeWorkflowRegistry implements CommandWorkflowRegistry {
  private readonly workflows = new Map<string, CommandWorkflow>();

  private static key(fabId: string, commandId: string): string {
    return `${fabId}\u0000${commandId}`;
  }

  register(fabId: string, commandId: string, workflow: CommandWorkflow): void {
    this.workflows.set(FakeWorkflowRegistry.key(fabId, commandId), workflow);
  }

  get(fabId: string, commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(FakeWorkflowRegistry.key(fabId, commandId));
  }
}

/**
 * Effect-Stream command source for tests. Every signal is a real Stream fed by a
 * PubSub; observer counters are incremented by Stream lifecycle effects so tests
 * can assert that a disposed runtime detached all stream consumers. The dirty
 * signal is a first-class channel (bounded-transport overflow contract).
 */
export class FakeCommandEventSource implements CommandEventSource {
  private readonly resultsBus = Effect.runSync(PubSub.unbounded<CommandResultEvent>());
  private readonly reconnectBus = Effect.runSync(PubSub.unbounded<void>());
  private readonly gapBus = Effect.runSync(PubSub.unbounded<CommandStreamGap>());
  private readonly failureBus = Effect.runSync(PubSub.unbounded<CommandTransportFailure>());
  private readonly statusBus = Effect.runSync(PubSub.unbounded<CommandConnectionStatus>());
  private readonly dirtyBus = Effect.runSync(PubSub.unbounded<CommandStreamDirty>());
  private resultCount = 0;
  private reconnectCount = 0;
  private gapCount = 0;
  private failureCount = 0;
  private statusCount = 0;
  private dirtyCount = 0;

  private countStream<A>(bus: PubSub.PubSub<A>, counters: { increment: () => void; decrement: () => void }): Stream.Stream<A> {
    return Stream.fromPubSub(bus).pipe(
      Stream.onStart(Effect.sync(counters.increment)),
      Stream.ensuring(Effect.sync(counters.decrement)),
    );
  }

  readonly commandResults = this.countStream(this.resultsBus, {
    increment: () => { this.resultCount += 1; },
    decrement: () => { this.resultCount = Math.max(0, this.resultCount - 1); },
  });
  readonly reconnected = this.countStream(this.reconnectBus, {
    increment: () => { this.reconnectCount += 1; },
    decrement: () => { this.reconnectCount = Math.max(0, this.reconnectCount - 1); },
  });
  readonly gaps = this.countStream(this.gapBus, {
    increment: () => { this.gapCount += 1; },
    decrement: () => { this.gapCount = Math.max(0, this.gapCount - 1); },
  });
  readonly transportFailures = this.countStream(this.failureBus, {
    increment: () => { this.failureCount += 1; },
    decrement: () => { this.failureCount = Math.max(0, this.failureCount - 1); },
  });
  readonly connectionStatus = this.countStream(this.statusBus, {
    increment: () => { this.statusCount += 1; },
    decrement: () => { this.statusCount = Math.max(0, this.statusCount - 1); },
  });
  readonly dirty = this.countStream(this.dirtyBus, {
    increment: () => { this.dirtyCount += 1; },
    decrement: () => { this.dirtyCount = Math.max(0, this.dirtyCount - 1); },
  });

  reconnect(): void { PubSub.publishUnsafe(this.reconnectBus, undefined); }

  /** Signal that backend replay could not cover a disconnect. */
  emitGap(gap: CommandStreamGap = { epoch: 'epoch-1', sequence: 7 }): void { PubSub.publishUnsafe(this.gapBus, gap); }

  /** Simulate an EventSource transport interruption (never a command outcome). */
  failTransport(failure: CommandTransportFailure = { message: 'transport failure' }): void {
    PubSub.publishUnsafe(this.statusBus, 'reconnecting');
    PubSub.publishUnsafe(this.failureBus, failure);
  }

  openStream(): void { PubSub.publishUnsafe(this.statusBus, 'open'); }

  /** Bounded-bus overflow / stale-generation / closed-connection signal. */
  emitDirty(dirty: CommandStreamDirty = { reason: 'overflow', droppedCount: 1 }): void {
    PubSub.publishUnsafe(this.dirtyBus, dirty);
  }

  get failureObservers(): number { return this.failureCount; }
  get commandObservers(): number { return this.resultCount; }
  get reconnectObservers(): number { return this.reconnectCount; }
  get gapObservers(): number { return this.gapCount; }
  get statusObservers(): number { return this.statusCount; }
  get dirtyObservers(): number { return this.dirtyCount; }

  emit(event: CommandResultEvent): void {
    PubSub.publishUnsafe(this.resultsBus, event);
  }

  /** Ends the live command stream; the bridge stops consuming it. */
  complete(): void {
    Effect.runSync(PubSub.shutdown(this.resultsBus));
  }
}

export function commandResult(
  input: { fabId: string; commandId: string; revision: number; outcome: CommandOutcome; occurredAt?: string },
): CommandResultEvent {
  return { occurredAt: '2026-10-27T00:00:00.000Z', ...input };
}

export function commandRecord(
  input: {
    siteId?: string;
    fabId: string;
    commandId: string;
    revision: number;
    outcome: CommandOutcome;
    occurredAt?: string;
  },
): CommandRecoveryRecord {
  return {
    siteId: 'site-1',
    occurredAt: '2026-10-27T00:00:00.000Z',
    terminal: input.outcome === 'succeeded' || input.outcome === 'failed' || input.outcome === 'cancelled',
    ...input,
  };
}

export function journalEvent(
  input: { sequence: number; fabId: string; commandId: string; revision: number; outcome: CommandOutcome; occurredAt?: string },
): CommandJournalEvent {
  return { occurredAt: '2026-10-27T00:00:00.000Z', ...input };
}

export function emptyRecoveryList(commands: readonly CommandRecoveryRecord[] = []): CommandRecoveryList {
  return { epoch: 'epoch-1', latestSequence: 0, commands };
}

export function emptyJournalPage(events: readonly CommandJournalEvent[] = []): CommandJournalPage {
  return { epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 0, events };
}

export interface FakeCommandGatewayOptions {
  readonly getCommandStatus?: (fabId: string, commandId: string) => Promise<CommandResultEvent | null>;
  readonly listFabCommands?: (siteId: string, fabId: string, filter: CommandRecoveryFilter) => Promise<CommandRecoveryList>;
  readonly getCommandJournalPage?: (siteId: string, fabId: string, cursor: CommandJournalQuery) => Promise<CommandJournalPage>;
}

/** Counts every authoritative call so recovery/scheduler tests can assert pressure. */
export class FakeCommandGateway implements CommandGateway {
  readonly statusCalls: Array<{ fabId: string; commandId: string }> = [];
  readonly listCalls: Array<{ siteId: string; fabId: string; filter: CommandRecoveryFilter }> = [];
  readonly journalCalls: Array<{ siteId: string; fabId: string; cursor: CommandJournalQuery }> = [];

  constructor(private readonly options: FakeCommandGatewayOptions = {}) {}

  async getCommandStatus(fabId: string, commandId: string): Promise<CommandResultEvent | null> {
    this.statusCalls.push({ fabId, commandId });
    return this.options.getCommandStatus ? this.options.getCommandStatus(fabId, commandId) : null;
  }

  async listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Promise<CommandRecoveryList> {
    this.listCalls.push({ siteId, fabId, filter });
    return this.options.listFabCommands ? this.options.listFabCommands(siteId, fabId, filter) : emptyRecoveryList();
  }

  async getCommandJournalPage(siteId: string, fabId: string, cursor: CommandJournalQuery): Promise<CommandJournalPage> {
    this.journalCalls.push({ siteId, fabId, cursor });
    return this.options.getCommandJournalPage ? this.options.getCommandJournalPage(siteId, fabId, cursor) : emptyJournalPage();
  }
}

export function fakeCommandGateway(options: FakeCommandGatewayOptions = {}): FakeCommandGateway {
  return new FakeCommandGateway(options);
}

/** Isolated Effect execution boundary for command tests (no application singleton). */
export interface CommandTestRuntime {
  readonly host: RuntimeHost;
  readonly rootScope: Scope.Closeable;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly services: ManagedRuntime.ManagedRuntime<never, never>;
  dispose(): Promise<void>;
}

export function createCommandTestRuntime(
  options: { readonly registry?: AtomRegistry.AtomRegistry } = {},
): CommandTestRuntime {
  const services = ManagedRuntime.make(Layer.empty);
  const rootScope = Scope.makeUnsafe();
  const registry = options.registry ?? AtomRegistry.make({ defaultIdleTTL: 300_000 });
  let disposed = false;
  return {
    host: {
      runSync: (effect) => services.runSync(effect),
      runPromise: (effect) => services.runPromise(effect),
    },
    rootScope,
    registry,
    services,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      services.runSync(Scope.close(rootScope, Exit.void));
      await services.dispose();
      registry.dispose();
    },
  };
}

export interface TestFabOptions {
  readonly fabId?: string;
  readonly siteId?: string;
  readonly source?: CommandEventSource;
  readonly sourceFor?: (fabId: string, scope: Scope.Scope) => CommandEventSource;
  readonly gateway?: CommandGateway;
  readonly createWorkflow?: CommandWorkflowFactory;
  readonly retention?: FabRuntimeRetentionOptions;
  readonly lazyCommandSubscription?: boolean;
  readonly maxConcurrentReconciliations?: number;
  readonly maxQueuedReconciliations?: number;
  readonly reconcileTimeoutMs?: number;
}

/** Build one FabRuntime on an isolated test runtime; call dispose() in afterEach. */
export function createFabRuntime(harness: CommandTestRuntime, options: TestFabOptions = {}): FabRuntime {
  const fallbackSource = options.source ?? new FakeCommandEventSource();
  const factory = new FabRuntimeFactory({
    runtime: harness.host,
    parentScope: harness.rootScope,
    projectionRegistry: harness.registry,
    sourceFor: options.sourceFor ?? (() => fallbackSource),
    gateway: options.gateway,
    createWorkflow: options.createWorkflow,
    retention: options.retention,
    lazyCommandSubscription: options.lazyCommandSubscription,
    maxConcurrentReconciliations: options.maxConcurrentReconciliations,
    maxQueuedReconciliations: options.maxQueuedReconciliations,
    reconcileTimeoutMs: options.reconcileTimeoutMs,
  });
  return factory.create(options.fabId ?? 'fab-a', options.siteId ?? 'site-1');
}

export interface TestFab {
  readonly runtime: FabRuntime;
  readonly harness: CommandTestRuntime;
  dispose(): Promise<void>;
}

export function createTestFab(options: TestFabOptions = {}): TestFab {
  const harness = createCommandTestRuntime();
  const runtime = createFabRuntime(harness, options);
  let disposed = false;
  return {
    runtime,
    harness,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      await harness.dispose();
    },
  };
}
