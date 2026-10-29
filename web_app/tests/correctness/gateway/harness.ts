import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import type {
  CommandGateway,
  CommandGatewayError,
  CommandJournalPage,
  CommandJournalQuery,
  CommandRecoveryList,
} from '@/contracts/command-gateway.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';
import {
  FabReconciliationScheduler,
  createPhysicalRequestBudget,
  type PhysicalRequestBudget,
  type ReconciliationDropDiagnostic,
} from '@/runtime/fab-reconciliation-scheduler';

/** Isolated Effect boundary for the F4 correctness tests (no application singleton). */
export interface GatewayTestRuntime {
  readonly runtime: RuntimeHost;
  readonly rootScope: Scope.Closeable;
  dispose(): Promise<void>;
}

export function createGatewayTestRuntime(): GatewayTestRuntime {
  const services = ManagedRuntime.make(Layer.empty);
  const rootScope = Scope.makeUnsafe();
  let disposed = false;
  return {
    runtime: {
      runSync: (effect) => services.runSync(effect),
      runPromise: (effect) => services.runPromise(effect),
    },
    rootScope,
    async dispose() {
      if (disposed) return;
      disposed = true;
      services.runSync(Scope.close(rootScope, Exit.void));
      await services.dispose();
    },
  };
}

export class RecordingWorkflow implements CommandWorkflow {
  readonly received: CommandResultEvent[] = [];
  receive(event: CommandResultEvent): void { this.received.push(event); }
  async reconcile(): Promise<void> {}
  dispose(): void {}
}

export const resultEvent = (input: {
  readonly commandId?: string;
  readonly revision: number;
  readonly outcome?: CommandResultEvent['outcome'];
}): CommandResultEvent => ({
  fabId: 'fab-a',
  commandId: input.commandId ?? 'cmd-1',
  revision: input.revision,
  outcome: input.outcome ?? 'executing',
  occurredAt: '2026-10-30T00:00:00.000Z',
});

export const emptyRecoveryList = (commands: CommandRecoveryList['commands'] = []): CommandRecoveryList => ({
  epoch: 'epoch-1',
  latestSequence: 0,
  commands,
});

export const emptyJournalPage = (query: CommandJournalQuery, events: CommandJournalPage['events'] = []): CommandJournalPage => ({
  epoch: query.epoch,
  hasGap: false,
  firstRetainedSequence: 0,
  latestSequence: query.afterSequence,
  events,
  nextAfterSequence: events.length > 0 ? events[events.length - 1].sequence : query.afterSequence,
});

/** Counters measured at the fake fetch layer (not the scheduler's logical stats). */
export interface PhysicalCounters {
  started: number;
  /** Physical requests currently open; the FAB invariant is <= 4. */
  pending: number;
  peak: number;
  aborts: number;
}

export const physicalCounters = (): PhysicalCounters => ({ started: 0, pending: 0, peak: 0, aborts: 0 });

function countOpen(counters: PhysicalCounters): void {
  counters.pending += 1;
  counters.peak = Math.max(counters.peak, counters.pending);
}

/** Fake fetch that never answers until the caller aborts; models the never-resolving gateway. */
export const hungFetch = (counters: PhysicalCounters) =>
  (_fabId: string, _commandId: string, signal: AbortSignal): Promise<CommandResultEvent | null> =>
    new Promise<CommandResultEvent | null>((_resolve, reject) => {
      counters.started += 1;
      countOpen(counters);
      signal.addEventListener('abort', () => {
        counters.aborts += 1;
        counters.pending -= 1;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });

/** Fake fetch that answers after delayMs while observing the fetch abort signal. */
export const delayedFetch = (counters: PhysicalCounters, delayMs: number) =>
  (fabId: string, commandId: string, signal: AbortSignal): Promise<CommandResultEvent | null> =>
    new Promise<CommandResultEvent | null>((resolve, reject) => {
      counters.started += 1;
      countOpen(counters);
      const timer = setTimeout(() => {
        counters.pending -= 1;
        resolve({ fabId, commandId, revision: 1, outcome: 'executing', occurredAt: '2026-10-30T00:00:00.000Z' });
      }, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        counters.aborts += 1;
        counters.pending -= 1;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });

/**
 * Native-Effect gateway whose one authoritative query behaves like
 * `fetch(url, { signal })` inside `Effect.tryPromise`: fiber interruption aborts
 * the signal, and the rejection maps into the gateway error algebra.
 */
export function effectGateway(handler: (fabId: string, commandId: string, signal: AbortSignal) => Promise<CommandResultEvent | null>): CommandGateway {
  return {
    getCommandStatus: (fabId, commandId) =>
      Effect.tryPromise({
        try: (signal: AbortSignal) => handler(fabId, commandId, signal),
        catch: (cause: unknown): CommandGatewayError =>
          isAbortCause(cause)
            ? { _tag: 'CommandRequestAborted', message: 'authoritative request aborted', cause }
            : { _tag: 'CommandGatewayRetryableFailure', message: 'authoritative request failed', cause },
      }),
    listFabCommands: () => Effect.succeed(emptyRecoveryList()),
    getCommandJournalPage: (_siteId, _fabId, query) => Effect.succeed(emptyJournalPage(query)),
  };
}

function isAbortCause(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('name' in cause)) return false;
  return cause.name === 'AbortError';
}

export interface SchedulerHarnessOptions {
  readonly gateway?: CommandGateway;
  readonly budget?: PhysicalRequestBudget;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly onDrop?: (diagnostic: ReconciliationDropDiagnostic) => void;
  readonly onReconciled?: (commandId: string) => void;
  /** Workflow identity guard; defaults to "always current". */
  readonly isCurrent?: (commandId: string) => boolean;
}

export interface SchedulerHarness {
  readonly scheduler: FabReconciliationScheduler;
  readonly budget: PhysicalRequestBudget;
  workflowFor(commandId: string): RecordingWorkflow;
}

/** Builds one scheduler on an isolated runtime; call scheduler.dispose() in afterEach. */
export function createSchedulerHarness(rt: GatewayTestRuntime, options: SchedulerHarnessOptions = {}): SchedulerHarness {
  const workflows = new Map<string, RecordingWorkflow>();
  const budget = options.budget ?? createPhysicalRequestBudget(4);
  const scheduler = new FabReconciliationScheduler({
    fabId: 'fab-a',
    runtime: rt.runtime,
    parentScope: rt.rootScope,
    physicalBudget: budget,
    ...(options.gateway ? { gateway: options.gateway } : {}),
    resolve: (commandId) => {
      let workflow = workflows.get(commandId);
      if (!workflow) {
        workflow = new RecordingWorkflow();
        workflows.set(commandId, workflow);
      }
      return { workflow, isCurrent: () => options.isCurrent ? options.isCurrent(commandId) : true };
    },
    isTerminal: () => false,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.maxQueued !== undefined ? { maxQueued: options.maxQueued } : {}),
    ...(options.onDrop ? { onDrop: options.onDrop } : {}),
    ...(options.onReconciled ? { onReconciled: options.onReconciled } : {}),
  });
  return {
    scheduler,
    budget,
    workflowFor(commandId: string): RecordingWorkflow {
      let workflow = workflows.get(commandId);
      if (!workflow) {
        workflow = new RecordingWorkflow();
        workflows.set(commandId, workflow);
      }
      return workflow;
    },
  };
}

/** Polls a synchronous predicate with real timers (native Effects use the real clock here). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out after ' + timeoutMs + 'ms');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
