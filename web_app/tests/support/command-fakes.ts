import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from 'effect';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandCoverAuthority,
  CommandCoverResult,
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

/**
 * Round 5.1 test doubles (P2-04). The doubles model the *protocol states* the
 * runtime must react to (realtime vs authoritative channel, expired-unresolved,
 * pending ACK ledger, cover results, connection lifecycle, revision/outcome
 * conflicts) instead of hiding them behind always-successful behaviour. Ordered
 * journal-position realism stays in the real transport tests
 * (realtime-transport.test.ts / matrix-1-*.test.ts); these doubles let FabRuntime
 * and bridge tests control the exact protocol state.
 */
export class FakeCommandWorkflow implements CommandWorkflow {
  /** Events the actor projection actually advanced on (either channel). */
  readonly events: CommandResultEvent[] = [];
  /** Every realtime-channel delivery attempt, including ignored ones. */
  readonly realtimeEvents: CommandResultEvent[] = [];
  /** Every authoritative-channel delivery attempt, including ignored ones. */
  readonly authoritativeEvents: CommandResultEvent[] = [];
  readonly reconciled: string[] = [];
  disposed = false;
  private expired = false;
  private revision = -1;
  private outcome: CommandOutcome | 'pending' = 'pending';
  private lastEventValue?: CommandResultEvent;

  /**
   * Realtime channel: strictly monotonic revisions only; an expired workflow can
   * never be revived by a realtime frame regardless of its revision.
   */
  receiveRealtime(event: CommandResultEvent): void {
    this.realtimeEvents.push(event);
    if (this.expired) return;
    if (!Number.isInteger(event.revision) || event.revision <= this.revision) return;
    this.apply(event);
  }

  /**
   * Authoritative channel: no revision rollback; equal revision is allowed so an
   * authoritative record can resolve expired / correct a wrong local outcome.
   */
  receiveAuthoritative(event: CommandResultEvent): void {
    this.authoritativeEvents.push(event);
    if (!Number.isInteger(event.revision) || event.revision < this.revision) return;
    this.expired = false;
    if (event.revision === this.revision && event.outcome === this.outcome) return;
    this.apply(event);
  }

  markExpiredUnresolved(): void { this.expired = true; }

  async reconcile(commandId: string): Promise<void> {
    this.reconciled.push(commandId);
  }

  dispose(): void {
    this.disposed = true;
  }

  get projection() {
    return {
      state: this.expired ? 'expired' : this.outcome === 'pending' ? 'idle' : this.outcome,
      revision: this.revision,
      outcome: this.outcome,
      recoveryDisposition: this.expired ? 'expired-unresolved' as const : 'tracked' as const,
    };
  }

  private apply(event: CommandResultEvent): void {
    this.revision = event.revision;
    this.outcome = event.outcome;
    this.lastEventValue = event;
    this.events.push(event);
  }

  get lastEvent(): CommandResultEvent | undefined {
    return this.lastEventValue;
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

  receiveRealtime(event: CommandResultEvent): void {
    if (this.expired) return;
    if (event.revision <= this.revision) return;
    this.apply(event);
  }

  receiveAuthoritative(event: CommandResultEvent): void {
    if (event.revision < this.revision) return;
    this.expired = false;
    if (event.revision === this.revision && event.outcome === this.outcome) return;
    this.apply(event);
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

  private apply(event: CommandResultEvent): void {
    this.revision = event.revision;
    this.outcome = event.outcome;
    this.events.push(event);
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

  unregister(fabId: string, commandId: string): void {
    this.workflows.delete(FakeWorkflowRegistry.key(fabId, commandId));
  }

  get(fabId: string, commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(FakeWorkflowRegistry.key(fabId, commandId));
  }
}

/** Placeholder-position conflict record (fake only; the queue owns the real type). */
interface FakeLedgerEntry {
  readonly cursor: CommandCursor;
  readonly event: CommandResultEvent;
  status: 'pending' | 'applied' | 'covered';
}

/** Controlled authoritative-cover outcome for the fake source. */
export type FakeCoverResult = 'covered' | 'insufficient';

/**
 * Effect-Stream command source for tests. Every signal is a real Stream fed by a
 * PubSub; observer counters are incremented by Stream lifecycle effects so tests
 * can assert that a disposed runtime detached all stream consumers.
 *
 * Round 5.1 behaviour:
 * - connectionStatus is a *stateful, controllable* lifecycle: it replays the
 *   current status to a new subscriber (like the real transport does for its
 *   first subscriber) and changes only through setConnectionStatus()/openStream()/
 *   failTransport(). It never announces an implicit 'open'.
 * - the ACK ledger is real: delivered frames become pending entries, acknowledge()
 *   only marks the matching identity applied, and the acknowledged cursor advances
 *   only over a contiguous applied|covered prefix. pendingAcknowledgements is the
 *   live ledger length (required contract field).
 * - cover() never modifies delivered (P1-04). A covered cover marks entries at or
 *   before the watermark covered and advances acknowledged; an insufficient cover
 *   changes nothing. coverNever advances delivered.
 * - deliverUnprocessed(event, cursor?) records a frame that reached the bounded
 *   consumer queue but was not yet consumed/applied (the post-cover pending-ACK
 *   race); emit() publishes it to the commandResults stream.
 * - the fake SSE has no server-assigned journal positions: unless a test supplies
 *   an explicit cursor, a delivered frame is recorded at the current safe
 *   acknowledged position (so a List snapshot at or above that position covers
 *   it). Ordered-position realism is owned by the real transport tests, per the
 *   Round 5.1 fake boundary (P2-04 §10.5).
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
  private connectionStatusValue: CommandConnectionStatus = 'closed';
  private observedCursor?: CommandCursor;
  private deliveredCursor?: CommandCursor;
  private acknowledgedCursorValue?: CommandCursor;
  private readonly ledger: FakeLedgerEntry[] = [];
  private ledgerEpochValue?: string;
  private coverResultValue: FakeCoverResult = 'covered';

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
  /**
   * Stateful lifecycle stream: a new subscriber first observes the current status
   * (exactly like the real transport's first-subscriber replay), then changes.
   * There is no unconditional 'open' announcement (P2-04 §10.1).
   */
  readonly connectionStatus: Stream.Stream<CommandConnectionStatus> = Stream.concat(
    Stream.suspend(() => Stream.succeed(this.connectionStatusValue)),
    this.countStream(this.statusBus, {
      increment: () => { this.statusCount += 1; },
      decrement: () => { this.statusCount = Math.max(0, this.statusCount - 1); },
    }),
  );
  readonly dirty = this.countStream(this.dirtyBus, {
    increment: () => { this.dirtyCount += 1; },
    decrement: () => { this.dirtyCount = Math.max(0, this.dirtyCount - 1); },
  });

  /** Record that the actor applied one delivered event; drains the safe prefix. */
  acknowledge(event: CommandResultEvent): void {
    const entry = this.ledger.find((candidate) =>
      candidate.status === 'pending' &&
      candidate.event.fabId === event.fabId &&
      candidate.event.commandId === event.commandId &&
      candidate.event.revision === event.revision);
    if (!entry) return;
    entry.status = 'applied';
    this.drainAcknowledgedPrefix();
  }

  /**
   * Authoritative cover. Only marks ledger entries / advances acknowledged (and
   * replaces the ledger epoch on an authoritative cross-epoch List cover). Never
   * modifies delivered or observed (P1-04).
   */
  cover(cursor: CommandCursor, authority: CommandCoverAuthority = 'journal', _lossBarrier?: number): CommandCoverResult {
    if (this.coverResultValue === 'insufficient' || !isValidCursor(cursor)) {
      return { status: 'insufficient', cursor: { ...cursor }, authority, latchReleased: false, reason: 'fake cover is configured insufficient', recovery: 'list' };
    }
    const previousEpoch = this.acknowledgedCursorValue?.epoch ?? this.ledgerEpochValue;
    const epochReplaced = previousEpoch !== undefined && previousEpoch !== cursor.epoch;
    if (epochReplaced && authority !== 'list') {
      return { status: 'insufficient', cursor: { ...cursor }, authority, latchReleased: false, reason: 'journal cover cannot replace an epoch', recovery: 'list' };
    }
    if (epochReplaced) {
      this.ledger.length = 0;
    } else {
      for (const entry of this.ledger) {
        if (entry.cursor.epoch === cursor.epoch && entry.cursor.sequence <= cursor.sequence) entry.status = 'covered';
      }
    }
    this.ledgerEpochValue = cursor.epoch;
    this.acknowledgedCursorValue = advanceSafeAcknowledged(this.acknowledgedCursorValue, cursor);
    this.drainAcknowledgedPrefix();
    return { status: 'covered', cursor: { ...cursor }, authority, latchReleased: false };
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
      pendingAcknowledgements: this.ledger.length,
    };
  }

  get pendingAcknowledgementCount(): number {
    return this.ledger.length;
  }

  /** Test seam: control the next cover() outcome (P2-04 §10.2). */
  setCoverResult(result: FakeCoverResult): void {
    this.coverResultValue = result;
  }

  /** Test seam: drive the connection lifecycle explicitly (P2-04 §10.1). */
  setConnectionStatus(status: CommandConnectionStatus): void {
    this.connectionStatusValue = status;
    PubSub.publishUnsafe(this.statusBus, status);
  }

  /** Test seam: force the recovery start cursor (e.g. a reconnect after a gap). */
  setAcknowledgedCursor(cursor: CommandCursor | undefined): void {
    this.acknowledgedCursorValue = cursor;
    this.ledger.length = 0;
  }

  reconnect(): void { PubSub.publishUnsafe(this.reconnectBus, undefined); }

  /** Signal that backend replay could not cover a disconnect. */
  emitGap(gap: CommandStreamGap = { epoch: 'epoch-1', sequence: 7 }): void { PubSub.publishUnsafe(this.gapBus, gap); }

  /** Simulate an EventSource transport interruption (never a command outcome). */
  failTransport(failure: CommandTransportFailure = { message: 'transport failure' }): void {
    this.setConnectionStatus('reconnecting');
    PubSub.publishUnsafe(this.failureBus, failure);
  }

  openStream(): void { this.setConnectionStatus('open'); }

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

  /**
   * Deliver one frame through the bounded consumer bus. An explicit cursor can be
   * supplied to model a real journal position; otherwise the frame is recorded at
   * the current safe acknowledged position (epoch-1:0 initially).
   */
  emit(event: CommandResultEvent, cursor?: CommandCursor): CommandCursor {
    const at = this.deliver(event, cursor);
    PubSub.publishUnsafe(this.resultsBus, event);
    return at;
  }

  /**
   * Record a delivered-but-not-yet-consumed frame: the transport/ledger has it as
   * pending, but the bridge has not seen/applied it (the exact post-cover race the
   * runtime barrier must reject).
   */
  deliverUnprocessed(event: CommandResultEvent, cursor?: CommandCursor): CommandCursor {
    return this.deliver(event, cursor);
  }

  /** Ends the live command stream; the bridge stops consuming it. */
  complete(): void {
    Effect.runSync(PubSub.shutdown(this.resultsBus));
  }

  private deliver(event: CommandResultEvent, cursor?: CommandCursor): CommandCursor {
    const at = cursor ?? this.defaultCursor();
    this.observedCursor = advanceFakeCursor(this.observedCursor, at);
    this.deliveredCursor = advanceFakeCursor(this.deliveredCursor, at);
    this.ledger.push({ cursor: at, event, status: 'pending' });
    return at;
  }

  /** Default delivered position: the current safe acknowledged position in this epoch. */
  private defaultCursor(): CommandCursor {
    const epoch = this.ledgerEpochValue ?? this.acknowledgedCursorValue?.epoch ?? 'epoch-1';
    const sequence = this.acknowledgedCursorValue !== undefined && this.acknowledgedCursorValue.epoch === epoch
      ? this.acknowledgedCursorValue.sequence
      : 0;
    return { epoch, sequence };
  }

  /** Advance acknowledged only over a contiguous applied|covered ledger prefix. */
  private drainAcknowledgedPrefix(): void {
    while (this.ledger.length > 0 && this.ledger[0].status !== 'pending') {
      const head = this.ledger.shift()!;
      this.acknowledgedCursorValue = advanceSafeAcknowledged(this.acknowledgedCursorValue, head.cursor);
    }
    if (this.ledger.length === 0) this.ledgerEpochValue = undefined;
  }
}

function isValidCursor(cursor: CommandCursor): boolean {
  return typeof cursor.epoch === 'string' && cursor.epoch.length > 0 &&
    Number.isSafeInteger(cursor.sequence) && cursor.sequence >= 0;
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
  /**
   * Connection lifecycle fixture for a FakeCommandEventSource (default 'open': a
   * test FAB starts connected). Pass 'closed'/'failed'/'reconnecting' to model an
   * idle/degraded runtime; the fake itself never announces 'open' implicitly.
   */
  readonly connectionStatus?: CommandConnectionStatus;
}

/** Build one FabRuntime on an isolated test runtime; call dispose() in afterEach. */
export function createFabRuntime(harness: CommandTestRuntime, options: TestFabOptions = {}): FabRuntime {
  const fallbackSource = options.source ?? new FakeCommandEventSource();
  if (fallbackSource instanceof FakeCommandEventSource) {
    fallbackSource.setConnectionStatus(options.connectionStatus ?? 'open');
  }
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

function advanceSafeAcknowledged(current: CommandCursor | undefined, candidate: CommandCursor): CommandCursor {
  if (!current) return candidate;
  if (current.epoch !== candidate.epoch) return current;
  return candidate.sequence > current.sequence ? candidate : current;
}
