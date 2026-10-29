import { afterEach, describe, expect, it } from 'vitest';
import type { CommandJournalPage } from '@/contracts/command-gateway.contract';
import {
  type TestFab,
  type TestFabOptions,
  FakeCommandEventSource,
  commandRecord,
  commandResult,
  createTestFab,
  emptyRecoveryList,
  fakeCommandGateway,
} from '../../support/command-fakes.ts';

/**
 * Matrix item 6 (ADR-010 4, CR-06): the recovery state machine must retain Dirty
 * across retryable failures, retry with bounded backoff (8 attempts),
 * automatically compensate after the network returns (without any new SSE
 * event), expose WaitingRetry/Unrecoverable diagnostics and clear Dirty only
 * after the authoritative watermark/list snapshot is applied.
 *
 * RED baseline: the recovery pass swallows failures and unconditionally clears
 * gapObserved in finally, so Dirty disappears without recovery and there is no
 * observable state or retry.
 */
const fabs: TestFab[] = [];
afterEach(async () => {
  for (const fab of fabs.splice(0)) await fab.dispose();
});

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RecoverySnapshot {
  readonly phase?: string;
  readonly attempts?: number;
  readonly lastError?: string;
}

const recoveryState = (runtime: unknown): RecoverySnapshot | undefined =>
  (runtime as { recoveryState?: RecoverySnapshot }).recoveryState;

const RECOVERY = { backoffMs: [1, 1, 1, 1, 1, 1, 1, 1], maxAttempts: 8 } as const;

function fab(options: Record<string, unknown>): TestFab {
  const created = createTestFab(options as unknown as TestFabOptions);
  fabs.push(created);
  return created;
}

function emitDirty(
  source: FakeCommandEventSource,
  dirty: Record<string, unknown>,
): void {
  (source.emitDirty as unknown as (value: Record<string, unknown>) => void)(dirty);
}

function pageWith(latestSequence: number): CommandJournalPage {
  const events = Array.from({ length: latestSequence }, (_, index) => ({
    sequence: index + 1,
    fabId: 'fab-a',
    commandId: 'cmd-1',
    revision: index + 1,
    // The terminal outcome is last: the actor stops mutating after it.
    outcome: index === latestSequence - 1 ? ('succeeded' as const) : ('executing' as const),
    occurredAt: '2026-10-30T00:00:00.000Z',
  }));
  return {
    epoch: 'epoch-1',
    hasGap: false,
    firstRetainedSequence: 0,
    latestSequence,
    events,
    nextAfterSequence: latestSequence,
  } as unknown as CommandJournalPage;
}

function baseGateway(overrides: Parameters<typeof fakeCommandGateway>[0]) {
  return fakeCommandGateway({
    listFabCommands: async () => emptyRecoveryList(),
    getCommandStatus: async (targetFab: string, commandId: string) =>
      commandResult({ fabId: targetFab, commandId, revision: 0, outcome: 'accepted' }),
    ...overrides,
  });
}

describe('matrix 6: recovery state machine (ADR-010 4)', () => {
  it('keeps Dirty through 5 intermittent 5xx failures and recovers without any new SSE event', async () => {
    const source = new FakeCommandEventSource();
    let journalAttempts = 0;
    const gateway = baseGateway({
      getCommandJournalPage: async () => {
        journalAttempts += 1;
        if (journalAttempts < 6) throw new Error('HTTP 503 transient');
        return pageWith(5);
      },
    });
    const created = fab({ source, gateway, recovery: RECOVERY });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(5);

    emitDirty(source, {
      reason: 'overflow',
      droppedCount: 2,
      delivered: { epoch: 'epoch-1', sequence: 0 },
      gapStart: 1,
      epoch: 'epoch-1',
      sequence: 0,
    });
    // No new SSE frame is emitted after the dirty signal.
    await expect.poll(() => journalAttempts, { timeout: 2_000 }).toBeGreaterThanOrEqual(6);
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(5);
    expect(recoveryState(runtime)?.phase).toBe('Healthy');
    expect(recoveryState(runtime)?.attempts).toBe(0);
  });

  it('exposes Dirty/Recovering/WaitingRetry while failing and never reports Healthy early', async () => {
    const source = new FakeCommandEventSource();
    let shouldFail = true;
    let attempts = 0;
    const gateway = baseGateway({
      getCommandJournalPage: async () => {
        attempts += 1;
        if (shouldFail) throw new Error('HTTP 503 transient');
        return pageWith(3);
      },
    });
    const created = fab({ source, gateway, recovery: RECOVERY });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(5);
    emitDirty(source, {
      reason: 'transport-failure',
      droppedCount: 1,
      delivered: { epoch: 'epoch-1', sequence: 0 },
      gapStart: 1,
      epoch: 'epoch-1',
      sequence: 0,
    });
    await expect.poll(() => attempts, { timeout: 2_000 }).toBeGreaterThanOrEqual(2);
    const during = recoveryState(runtime)?.phase;
    expect(['Dirty', 'Recovering', 'WaitingRetry']).toContain(during);
    expect(recoveryState(runtime)?.lastError).toBeDefined();

    shouldFail = false;
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(3);
    expect(recoveryState(runtime)?.phase).toBe('Healthy');
  });

  it('becomes Unrecoverable after the bounded retry budget and keeps the condition observable', async () => {
    const source = new FakeCommandEventSource();
    let attempts = 0;
    const gateway = baseGateway({
      // store-fault forces the authoritative list path; it keeps failing retryably.
      listFabCommands: async () => {
        attempts += 1;
        // Retryable transport-style 5xx (not an explicit store-fault classification).
        throw new Error('HTTP 503 transient');
      },
    });
    const created = fab({ source, gateway, recovery: { backoffMs: [1], maxAttempts: 3 } });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(5);
    emitDirty(source, {
      reason: 'store-fault',
      droppedCount: 1,
      delivered: { epoch: 'epoch-1', sequence: 0 },
      gapStart: 1,
      epoch: 'epoch-1',
      sequence: 0,
    });
    await expect.poll(() => recoveryState(runtime)?.phase, { timeout: 2_000 }).toBe('Unrecoverable');
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(recoveryState(runtime)?.lastError).toMatch(/503|store/i);
  });

  it('uses the authoritative list on epoch mismatch and clears Dirty only after the snapshot applies', async () => {
    const source = new FakeCommandEventSource();
    const gateway = baseGateway({
      getCommandJournalPage: async () => {
        throw new Error('409 journal-epoch-mismatch');
      },
      listFabCommands: async () =>
        emptyRecoveryList([
          commandRecord({ fabId: 'fab-a', commandId: 'cmd-1', revision: 6, outcome: 'executing' }),
        ]),
    });
    const created = fab({ source, gateway, recovery: RECOVERY });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(5);
    emitDirty(source, {
      reason: 'stale-generation',
      droppedCount: 1,
      delivered: { epoch: 'old-epoch', sequence: 3 },
      gapStart: 4,
      epoch: 'old-epoch',
      sequence: 3,
    });
    await expect.poll(() => runtime.getProjection('cmd-1')?.revision, { timeout: 2_000 }).toBe(6);
    expect(recoveryState(runtime)?.phase).toBe('Healthy');
  });

  it('stops retry timers on dispose (no work after teardown)', async () => {
    const source = new FakeCommandEventSource();
    let attempts = 0;
    const gateway = baseGateway({
      getCommandJournalPage: async () => {
        attempts += 1;
        throw new Error('503 transient');
      },
    });
    const created = fab({ source, gateway, recovery: { backoffMs: [5, 5, 5, 5], maxAttempts: 8 } });
    const runtime = created.runtime;
    runtime.start();
    runtime.trackCommand('cmd-1');
    await flush(5);
    emitDirty(source, {
      reason: 'overflow',
      droppedCount: 1,
      delivered: { epoch: 'epoch-1', sequence: 0 },
      gapStart: 1,
      epoch: 'epoch-1',
      sequence: 0,
    });
    await expect.poll(() => attempts, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
    runtime.dispose();
    const afterDispose = attempts;
    await flush(50);
    expect(attempts).toBe(afterDispose);
  });
});
