import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from 'effect';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandCoverAuthority,
  CommandCursor,
  CommandEventSource,
  CommandOutcome,
  CommandProtocolDiagnostic,
  CommandResultEvent,
  CommandSourceAvailability,
  CommandSourceCursors,
  CommandStreamDirty,
  CommandStreamGap,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import type {
  CommandGateway,
  CommandGatewayError,
  CommandJournalEvent,
  CommandJournalPage,
  CommandJournalQuery,
  CommandRecoveryFilter,
  CommandRecoveryList,
  CommandRecoveryRecord,
} from '@/contracts/command-gateway.contract';
import type { CommandWorkflow, CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';
import type {
  CommandWorkflowFactory,
  FabRuntimeRecoveryOptions,
  FabRuntimeRetentionOptions,
} from '@/runtime/fab-runtime';
import { FabRuntime } from '@/runtime/fab-runtime';
import { FabRuntimeFactory } from '@/runtime/fab-runtime-factory';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

export class FakeCommandWorkflow implements CommandWorkflow {
  readonly events: CommandResultEvent[] = [];
  readonly reconciled: string[] = [];
  disposed = false;
  private expired = false;

  receive(event: CommandResultEvent): void {
    this.events.push(event);
    this.expired = false;
  }

  markExpiredUnresolved(): void { this.expired = true; }

  get projection() {
    const event = this.events.reduce<CommandResultEvent | undefined>((latest, candidate) =>
      latest === undefined || candidate.revision > latest.revision ? candidate : latest, undefined);
    return {
      state: this.expired ? 'expired' : event?.outcome ?? 'idle',
      revision: event?.revision ?? -1,
      outcome: event?.outcome ?? 'pending' as const,
      recoveryDisposition: this.expired ? 'expired-unresolved' as const : 'tracked' as const,
    };
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
  private expired = false;
  disposeCalls = 0;

  constructor(readonly fabId: string, readonly commandId: string) {}

  receive(event: CommandResultEvent): void {
    if (event.revision <= this.revision) return;
    this.revision = event.revision;
    this.outcome = event.outcome;
    this.expired = false;
  }

  markExpiredUnresolved(): void { this.expired = true; }

  async reconcile(): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
  }

  get projection() {
    return {
      state: this.expired ? 'expired' : this.outcome === 'pending' ? 'idle' : this.outcome,
      revision: this.revision,
      outcome: this.outcome,
      recoveryDisposition: this.expired ? 'expired-unresolved' as const : 'tracked' as const,
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
  private observedCursor?: CommandCursor;
  private deliveredCursor?: CommandCursor;
  private acknowledgedCursorValue?: CommandCursor;

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
  readonly connectionStatus = Stream.concat(Stream.succeed<CommandConnectionStatus>('open'), this.countStream(this.statusBus, {
    increment: () => { this.statusCount += 1; },
    decrement: () => { this.statusCount = Math.max(0, this.statusCount - 1); },
  }));
  readonly dirty = this.countStream(this.dirtyBus, {
    increment: () => { this.dirtyCount += 1; },
    decrement: () => { this.dirtyCount = Math.max(0, this.dirtyCount - 1); },
  });

  /** ADR-010 §6.2 test double: the consumer reports an applied event. The real
   * ordered-ledger prefix enforcement is covered against the SSE transport; this
   * fake only tracks the observable cursor for FabRuntime-level tests. */
  acknowledge(event: CommandResultEvent): void {
    this.acknowledgedCursorValue = advanceFakeCursor(this.acknowledgedCursorValue, {
      epoch: 'epoch-1',
      sequence: event.revision,
    });
  }

  /** ADR-010 §6.2: authoritative recovery safe watermark from FabRuntime. */
  cover(cursor: CommandCursor, authority: CommandCoverAuthority = 'journal') {
    this.acknowledgedCursorValue = advanceFakeCursor(this.acknowledgedCursorValue, cursor);
    this.deliveredCursor = advanceFakeCursor(this.deliveredCursor, cursor);
    return { status: 'covered' as const, cursor, authority, latchReleased: false };
  }

  readonly lossGeneration = 0;

  readonly availability: CommandSourceAvailability = 'ready';

  get protocolDiagnostics(): readonly CommandProtocolDiagnostic[] {
    return [];
  }

  get cursors(): CommandSourceCursors {
    return {
      ...(this.observedCursor ? { observed: this.observedCursor } : {}),
      ...(this.deliveredCursor ? { delivered: this.deliveredCursor } : {}),
      ...(this.acknowledgedCursorValue ? { acknowledged: this.acknowledgedCursorValue } : {}),
    };
  }

  /** Test seam: force the recovery start cursor (e.g. a reconnect after a gap). */
  setAcknowledgedCursor(cursor: CommandCursor | undefined): void {
    this.acknowledgedCursorValue = cursor;
  }

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
    const cursor: CommandCursor = { epoch: 'epoch-1', sequence: event.revision };
    this.observedCursor = advanceFakeCursor(this.observedCursor, cursor);
    this.deliveredCursor = advanceFakeCursor(this.deliveredCursor, cursor);
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
  return {
    epoch: 'epoch-1',
    hasGap: false,
    firstRetainedSequence: 0,
    latestSequence: 0,
    events,
    nextAfterSequence: events.length > 0 ? events[events.length - 1].sequence : 0,
  };
}

/** A gateway handler may answer synchronously with a Promise (test convenience) or a native Effect. */
export type FakeGatewayHandler<T> = () => Promise<T> | Effect.Effect<T, CommandGatewayError>;

const isCommandGatewayFailure = (value: unknown): value is CommandGatewayError =>
  typeof value === 'object' && value !== null && '_tag' in value;

/**
 * Classifies a thrown/rejected test error into the ADR-011 error algebra so the
 * recovery state machine sees the same discriminants as the HTTP gateway.
 * Tests may also return a native Effect.fail(CommandGatewayError) directly.
 */
export function classifyFakeGatewayFailure(cause: unknown): CommandGatewayError {
  if (isCommandGatewayFailure(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/journal-epoch-mismatch|\b409\b/i.test(message)) {
    return { _tag: 'CommandJournalEpochMismatch', message, currentEpoch: 'epoch-2', firstRetainedSequence: 0, latestSequence: 0 };
  }
  if (/store[- _]?fault|COMMAND_STORE_UNAVAILABLE/i.test(message)) {
    return { _tag: 'CommandGatewayTerminalFailure', reason: 'store-fault', message };
  }
  if (/\b4\d\d\b/.test(message)) {
    return { _tag: 'CommandGatewayTerminalFailure', reason: 'rejected', message, status: Number(message.match(/\b(4\d\d)\b/)?.[1]) };
  }
  return { _tag: 'CommandGatewayRetryableFailure', message, ...(message.match(/\b5(\d\d)\b/) ? { status: 500 + Number(message.match(/\b5(\d\d)\b/)?.[1]) } : {}) };
}

function fakeHandlerEffect<T>(run: () => Promise<T> | Effect.Effect<T, CommandGatewayError>): Effect.Effect<T, CommandGatewayError> {
  const result = run();
  if (Effect.isEffect(result)) return result as Effect.Effect<T, CommandGatewayError>;
  return Effect.tryPromise({
    try: () => result,
    catch: (cause) => classifyFakeGatewayFailure(cause),
  });
}

/**
 * Test journal pages may omit the server-provided nextAfterSequence; the fake
 * derives it from the last event (or 0) so existing fixtures stay readable while
 * the production contract keeps the field required.
 */
export type FakeJournalPage = Omit<CommandJournalPage, 'nextAfterSequence'> & { readonly nextAfterSequence?: number };

function normalizeFakeJournalPage(page: FakeJournalPage): CommandJournalPage {
  const derived = page.events.length > 0 ? page.events[page.events.length - 1].sequence : 0;
  return { ...page, nextAfterSequence: page.nextAfterSequence ?? derived };
}

export interface FakeCommandGatewayOptions {
  readonly getCommandStatus?: (fabId: string, commandId: string) => Promise<CommandResultEvent | null> | Effect.Effect<CommandResultEvent | null, CommandGatewayError>;
  readonly listFabCommands?: (siteId: string, fabId: string, filter: CommandRecoveryFilter) => Promise<CommandRecoveryList> | Effect.Effect<CommandRecoveryList, CommandGatewayError>;
  readonly getCommandJournalPage?: (siteId: string, fabId: string, cursor: CommandJournalQuery) => Promise<FakeJournalPage> | Effect.Effect<FakeJournalPage, CommandGatewayError>;
}

/** Counts every authoritative call so recovery/scheduler tests can assert pressure. */
export class FakeCommandGateway implements CommandGateway {
  readonly statusCalls: Array<{ fabId: string; commandId: string }> = [];
  readonly listCalls: Array<{ siteId: string; fabId: string; filter: CommandRecoveryFilter }> = [];
  readonly journalCalls: Array<{ siteId: string; fabId: string; cursor: CommandJournalQuery }> = [];

  constructor(private readonly options: FakeCommandGatewayOptions = {}) {}

  getCommandStatus(fabId: string, commandId: string): Effect.Effect<CommandResultEvent | null, CommandGatewayError> {
    this.statusCalls.push({ fabId, commandId });
    const handler = this.options.getCommandStatus;
    return handler ? fakeHandlerEffect(() => handler(fabId, commandId)) : Effect.succeed(null);
  }

  listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Effect.Effect<CommandRecoveryList, CommandGatewayError> {
    this.listCalls.push({ siteId, fabId, filter });
    const handler = this.options.listFabCommands;
    return handler ? fakeHandlerEffect(() => handler(siteId, fabId, filter)) : Effect.succeed(emptyRecoveryList());
  }

  getCommandJournalPage(siteId: string, fabId: string, cursor: CommandJournalQuery): Effect.Effect<CommandJournalPage, CommandGatewayError> {
    this.journalCalls.push({ siteId, fabId, cursor });
    const handler = this.options.getCommandJournalPage;
    return handler
      ? fakeHandlerEffect(() => handler(siteId, fabId, cursor)).pipe(Effect.map(normalizeFakeJournalPage))
      : Effect.succeed(emptyJournalPage());
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
  /** ADR-010 §4 recovery bounds/backoff (test seam). */
  readonly recovery?: FabRuntimeRecoveryOptions;
  readonly lazyCommandSubscription?: boolean;
  readonly maxConcurrentReconciliations?: number;
  readonly maxQueuedReconciliations?: number;
  readonly reconcileTimeoutMs?: number;
  /** R4-08: active command admission bound for tests that intentionally exceed the default. */
  readonly maxActiveCommands?: number;
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
    recovery: options.recovery,
    lazyCommandSubscription: options.lazyCommandSubscription,
    maxConcurrentReconciliations: options.maxConcurrentReconciliations,
    maxQueuedReconciliations: options.maxQueuedReconciliations,
    reconcileTimeoutMs: options.reconcileTimeoutMs,
    maxActiveCommands: options.maxActiveCommands,
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

/** ADR-011 error helpers for recovery tests (typed, no thrown strings needed). */
export const gatewayFailures = {
  retryable(message: string, status?: number): CommandGatewayError {
    return { _tag: 'CommandGatewayRetryableFailure', message, ...(status !== undefined ? { status } : {}) };
  },
  epochMismatch(message = 'journal-epoch-mismatch', currentEpoch = 'epoch-2'): CommandGatewayError {
    return { _tag: 'CommandJournalEpochMismatch', message, currentEpoch, firstRetainedSequence: 0, latestSequence: 0 };
  },
  storeFault(message = 'COMMAND_STORE_UNAVAILABLE'): CommandGatewayError {
    return { _tag: 'CommandGatewayTerminalFailure', reason: 'store-fault', message };
  },
  rejected(message = 'invalid response'): CommandGatewayError {
    return { _tag: 'CommandGatewayTerminalFailure', reason: 'invalid-response', message };
  },
  aborted(message = 'aborted'): CommandGatewayError {
    return { _tag: 'CommandRequestAborted', message };
  },
} as const;

/** Cursor helper for ADR-010 tests. */
export function commandCursor(epoch: string, sequence: number): CommandCursor {
  return { epoch, sequence };
}

function advanceFakeCursor(current: CommandCursor | undefined, candidate: CommandCursor): CommandCursor {
  if (!current) return candidate;
  if (current.epoch === candidate.epoch) return candidate.sequence >= current.sequence ? candidate : current;
  return candidate;
}
