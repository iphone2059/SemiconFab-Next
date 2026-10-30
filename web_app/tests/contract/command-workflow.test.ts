/**
 * Round 5.1 / P1-03 - workflow source isolation contract.
 *
 * The workflow contract has no source-agnostic receive(): the *data source* of a
 * result decides the channel. These tests exercise the real XState machine and
 * adapter against the spec §5.5 matrix:
 *
 * - realtime is strictly monotonic live SSE: it never resolves expired-unresolved
 *   (any revision) and never corrects a terminal projection;
 * - authoritative is a validated List/Journal record: no revision rollback, but it
 *   resolves expired (equal revision included) and corrects wrong projections,
 *   including same-revision terminal corrections;
 * - expired-unresolved is a client recovery state with a stable retained snapshot.
 */
import { describe, expect, it } from 'vitest';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandWorkflow, CommandWorkflowProjection } from '@/contracts/command-workflow.contract';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';
import { commandResult } from '../support/command-fakes.ts';

const fabId = 'fab-a';
const commandId = 'cmd-1';

function realtime(revision: number, outcome: CommandOutcome, overrides: Partial<CommandResultEvent> = {}): CommandResultEvent {
  return commandResult({ fabId, commandId, revision, outcome, ...overrides });
}

function authoritative(revision: number, outcome: CommandOutcome, overrides: Partial<CommandResultEvent> = {}): CommandResultEvent {
  return commandResult({ fabId, commandId, revision, outcome, occurredAt: '2026-10-30T12:00:00.000Z', ...overrides });
}

/** Drive a fresh workflow to `executing` at `revision` and expire it. */
function expiredWorkflow(revision = 2): XStateCommandWorkflowAdapter {
  const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
  workflow.receiveRealtime(realtime(1, 'accepted'));
  workflow.receiveRealtime(realtime(revision, 'executing'));
  workflow.markExpiredUnresolved();
  return workflow;
}

function projection(workflow: XStateCommandWorkflowAdapter): CommandWorkflowProjection {
  return workflow.projection;
}

describe('realtime channel (live SSE observations)', () => {
  it('drives the XState v6 command machine through accepted/executing/succeeded', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    expect(workflow.state).toBe('idle');
    workflow.receiveRealtime(realtime(1, 'accepted'));
    expect(workflow.state).toBe('accepted');
    expect(projection(workflow)).toEqual({ state: 'accepted', revision: 1, outcome: 'accepted', recoveryDisposition: 'tracked' });
    workflow.receiveRealtime(realtime(2, 'executing'));
    expect(workflow.state).toBe('executing');
    workflow.receiveRealtime(realtime(3, 'succeeded'));
    expect(workflow.state).toBe('succeeded');
    expect(workflow.isTerminal).toBe(true);
    expect(workflow.context).toMatchObject({ fabId, commandId, revision: 3, outcome: 'succeeded' });
    expect(projection(workflow)).toEqual({ state: 'succeeded', revision: 3, outcome: 'succeeded', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('is strictly monotonic: duplicate, stale and same-revision conflicting frames never mutate the projection', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    const executing = realtime(2, 'executing');
    workflow.receiveRealtime(executing);
    const before = workflow.context;

    workflow.receiveRealtime(realtime(2, 'executing')); // duplicate
    workflow.receiveRealtime(realtime(1, 'accepted')); // stale
    workflow.receiveRealtime(realtime(2, 'failed')); // same-revision conflict: not a local write
    expect(workflow.state).toBe('executing');
    expect(workflow.context).toEqual(before);
    expect(workflow.context.lastEvent?.revision).toBe(2);
    expect(workflow.context.lastEvent?.outcome).toBe('executing');

    workflow.receiveRealtime(realtime(3, 'failed'));
    expect(projection(workflow)).toEqual({ state: 'failed', revision: 3, outcome: 'failed', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('never corrects a terminal projection, whatever the revision or outcome', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    workflow.receiveRealtime(realtime(2, 'executing'));
    workflow.receiveRealtime(realtime(3, 'succeeded'));
    const before = workflow.context;

    workflow.receiveRealtime(realtime(3, 'failed')); // same revision, conflicting outcome
    workflow.receiveRealtime(realtime(4, 'failed')); // later realtime frame
    expect(workflow.state).toBe('succeeded');
    expect(projection(workflow)).toEqual({ state: 'succeeded', revision: 3, outcome: 'succeeded', recoveryDisposition: 'tracked' });
    expect(workflow.context).toEqual(before);
    workflow.dispose();
  });
});

describe('expired-unresolved client recovery state', () => {
  it('keeps the retained revision/outcome when executing -> expired', () => {
    const workflow = expiredWorkflow(2);
    expect(workflow.state).toBe('expired');
    expect(workflow.isTerminal).toBe(false);
    expect(projection(workflow)).toEqual({
      state: 'expired',
      revision: 2,
      outcome: 'executing',
      recoveryDisposition: 'expired-unresolved',
    });
    expect(workflow.context).toMatchObject({ fabId, commandId, revision: 2, outcome: 'executing' });
    expect(workflow.context.lastEvent).toMatchObject({ revision: 2, outcome: 'executing' });
    workflow.dispose();
  });

  it('P1-03 core: no realtime frame can revive expired or mutate the retained snapshot (revisions 5/6/7)', () => {
    const workflow = expiredWorkflow(2);
    const before = workflow.context;
    const attempts: Array<[number, CommandOutcome]> = [
      [5, 'executing'],
      [6, 'succeeded'],
      [7, 'failed'],
      [5, 'accepted'],
      [2, 'executing'],
      [1, 'cancelled'],
    ];
    for (const [revision, outcome] of attempts) {
      workflow.receiveRealtime(realtime(revision, outcome));
      expect(workflow.state, `realtime rev ${revision} ${outcome} must not leave expired`).toBe('expired');
      expect(workflow.projection).toEqual({
        state: 'expired',
        revision: 2,
        outcome: 'executing',
        recoveryDisposition: 'expired-unresolved',
      });
      expect(workflow.context, `realtime rev ${revision} ${outcome} must not mutate context`).toEqual(before);
    }
    expect(workflow.context.revision).toBe(2);
    expect(workflow.context.outcome).toBe('executing');
    workflow.dispose();
  });

  it('stays expired when Recovery proves another authoritative miss (EXPIRE in expired)', () => {
    const workflow = expiredWorkflow(2);
    const before = workflow.context;
    workflow.markExpiredUnresolved();
    expect(workflow.state).toBe('expired');
    expect(workflow.context).toEqual(before);
    expect(projection(workflow).recoveryDisposition).toBe('expired-unresolved');
    workflow.dispose();
  });

  it('rejects an older authoritative revision without rolling back', () => {
    const workflow = expiredWorkflow(5);
    const before = workflow.context;
    workflow.receiveAuthoritative(authoritative(4, 'executing'));
    expect(workflow.state).toBe('expired');
    expect(workflow.context).toEqual(before);
    expect(projection(workflow)).toMatchObject({ revision: 5, outcome: 'executing', recoveryDisposition: 'expired-unresolved' });
    workflow.dispose();
  });
});

describe('authoritative channel resolving expired-unresolved', () => {
  it('resolves expired with a higher authoritative revision (active and terminal records)', () => {
    const workflow = expiredWorkflow(2);
    workflow.receiveAuthoritative(authoritative(5, 'executing'));
    expect(workflow.state).toBe('executing');
    expect(workflow.isTerminal).toBe(false);
    expect(projection(workflow)).toEqual({ state: 'executing', revision: 5, outcome: 'executing', recoveryDisposition: 'tracked' });

    workflow.markExpiredUnresolved();
    expect(projection(workflow)).toMatchObject({ state: 'expired', revision: 5, recoveryDisposition: 'expired-unresolved' });
    workflow.receiveAuthoritative(authoritative(6, 'succeeded'));
    expect(workflow.state).toBe('succeeded');
    expect(workflow.isTerminal).toBe(true);
    expect(projection(workflow)).toEqual({ state: 'succeeded', revision: 6, outcome: 'succeeded', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('resolves expired with the SAME revision and same retained outcome (duplicate resolution)', () => {
    const workflow = expiredWorkflow(2);
    workflow.receiveAuthoritative(authoritative(2, 'executing'));
    expect(workflow.state).toBe('executing');
    expect(projection(workflow)).toEqual({ state: 'executing', revision: 2, outcome: 'executing', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('applies the same-revision authoritative outcome as a correction of the expired snapshot', () => {
    const workflow = expiredWorkflow(2);
    workflow.receiveAuthoritative(authoritative(2, 'failed'));
    expect(workflow.state).toBe('failed');
    expect(workflow.isTerminal).toBe(true);
    expect(projection(workflow)).toEqual({ state: 'failed', revision: 2, outcome: 'failed', recoveryDisposition: 'tracked' });
    expect(workflow.context.revision).toBe(2);
    workflow.dispose();
  });
});

describe('authoritative channel on active projections', () => {
  it('applies forward revisions and never rolls back', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(2, 'executing'));
    const before = workflow.context;

    workflow.receiveAuthoritative(authoritative(1, 'accepted'));
    expect(workflow.state).toBe('executing');
    expect(workflow.context).toEqual(before);

    workflow.receiveAuthoritative(authoritative(3, 'failed'));
    expect(projection(workflow)).toEqual({ state: 'failed', revision: 3, outcome: 'failed', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('no-ops a same-revision duplicate and applies a same-revision correction', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(2, 'executing'));
    const before = workflow.context;

    workflow.receiveAuthoritative(authoritative(2, 'executing'));
    expect(workflow.context).toEqual(before);

    // Authoritative correction: the actor projection was wrong at this revision.
    workflow.receiveAuthoritative(authoritative(2, 'failed'));
    expect(projection(workflow)).toEqual({ state: 'failed', revision: 2, outcome: 'failed', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });
});

describe('authoritative correction of a terminal projection (not XState final)', () => {
  it('corrects a wrong terminal outcome at the same revision and accepts a later authoritative revision', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    workflow.receiveRealtime(realtime(2, 'executing'));
    workflow.receiveRealtime(realtime(3, 'succeeded'));
    const terminal = workflow.context;

    // Duplicate authoritative record: no mutation.
    workflow.receiveAuthoritative(authoritative(3, 'succeeded'));
    expect(workflow.context).toEqual(terminal);

    // Same revision, different outcome: authoritative correction replaces the
    // terminal projection; the revision is unchanged.
    workflow.receiveAuthoritative(authoritative(3, 'failed'));
    expect(workflow.state).toBe('failed');
    expect(projection(workflow)).toEqual({ state: 'failed', revision: 3, outcome: 'failed', recoveryDisposition: 'tracked' });

    // A later realtime frame is still ignored after the correction.
    workflow.receiveRealtime(realtime(4, 'succeeded'));
    expect(projection(workflow)).toMatchObject({ state: 'failed', revision: 3, outcome: 'failed' });

    // A higher authoritative revision applies normally.
    workflow.receiveAuthoritative(authoritative(4, 'succeeded'));
    expect(workflow.state).toBe('succeeded');
    expect(projection(workflow)).toEqual({ state: 'succeeded', revision: 4, outcome: 'succeeded', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('rejects an older authoritative revision for a terminal projection', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(3, 'succeeded'));
    const before = workflow.context;
    workflow.receiveAuthoritative(authoritative(2, 'failed'));
    expect(workflow.state).toBe('succeeded');
    expect(workflow.isTerminal).toBe(true);
    expect(workflow.context).toEqual(before);
    workflow.dispose();
  });
});

describe('protocol validation in the machine guards', () => {
  it('rejects foreign identity, non-integer revisions and invalid outcomes on the authoritative channel', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    const before = workflow.context;

    workflow.receiveAuthoritative(authoritative(2, 'succeeded', { fabId: 'fab-b' }));
    workflow.receiveAuthoritative(authoritative(2, 'succeeded', { commandId: 'cmd-2' }));
    workflow.receiveAuthoritative(authoritative(2.5, 'succeeded'));
    workflow.receiveAuthoritative(authoritative(Number.NaN, 'succeeded'));
    workflow.receiveAuthoritative({ ...authoritative(2, 'succeeded'), outcome: 'unknown' as CommandOutcome });
    expect(workflow.state).toBe('accepted');
    expect(workflow.context).toEqual(before);

    // The valid path still works after the rejected attempts.
    workflow.receiveAuthoritative(authoritative(2, 'succeeded'));
    expect(projection(workflow)).toMatchObject({ state: 'succeeded', revision: 2, outcome: 'succeeded' });
    workflow.dispose();
  });

  it('rejects a negative authoritative revision even for an untouched command (revision must be >= 0)', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveAuthoritative(authoritative(-1, 'succeeded'));
    expect(workflow.state).toBe('idle');
    expect(projection(workflow)).toEqual({ state: 'idle', revision: -1, outcome: 'pending', recoveryDisposition: 'tracked' });
    workflow.dispose();
  });

  it('rejects foreign identity and invalid outcomes on the realtime channel too', () => {
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    const before = workflow.context;

    workflow.receiveRealtime(realtime(2, 'executing', { fabId: 'fab-b' }));
    workflow.receiveRealtime(realtime(2, 'executing', { commandId: 'cmd-2' }));
    workflow.receiveRealtime({ ...realtime(2, 'executing'), outcome: 'unknown' as CommandOutcome });
    workflow.receiveRealtime(realtime(2.5, 'executing'));
    expect(workflow.state).toBe('accepted');
    expect(workflow.context).toEqual(before);
    workflow.dispose();
  });
});

describe('workflow contract surface', () => {
  it('exposes receiveRealtime/receiveAuthoritative and no source-agnostic receive', () => {
    const adapter = new XStateCommandWorkflowAdapter(fabId, commandId);
    const contract: CommandWorkflow = adapter;
    expect(typeof contract.receiveRealtime).toBe('function');
    expect(typeof contract.receiveAuthoritative).toBe('function');
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    expect(methods).toContain('receiveRealtime');
    expect(methods).toContain('receiveAuthoritative');
    expect(methods).not.toContain('receive');
    expect(adapter).not.toHaveProperty('receive');
    adapter.dispose();
  });
});

describe('scheduler authority', () => {
  it('does not reconcile through the workflow adapter: the scheduler is the only authority (ADR-011 §2.2)', async () => {
    // Direct per-workflow reconciliation would bypass the FAB physical budget,
    // timeout and stale-result guard, so the adapter owns no network authority.
    const workflow = new XStateCommandWorkflowAdapter(fabId, commandId);
    workflow.receiveRealtime(realtime(1, 'accepted'));
    await workflow.reconcile(commandId);
    expect(workflow.state, 'adapter.reconcile is a no-op; only the scheduler converges').toBe('accepted');
    expect(workflow.context.revision).toBe(1);
    workflow.dispose();
  });
});
