import { describe, expect, it } from 'vitest';
import { CommandCorrelationRegistry } from '@/runtime/command-correlation-registry';
import { CommandConfigurationError } from '@/contracts/command-config';
import { commandResult } from '../support/command-fakes.ts';

const fabId = 'fab-a';
const result = (commandId: string, revision: number, outcome: Parameters<typeof commandResult>[0]['outcome']) =>
  commandResult({ fabId, commandId, revision, outcome });

it('evicts the oldest *completed* terminal, not the longest-running one that finishes last', () => {
  // Audited scenario: A starts running first, B completes, then A completes last.
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 1, terminalTtlMs: 0 });
  registry.observe(result('A', 1, 'executing'));
  registry.observe(result('B', 2, 'succeeded'));
  // Terminal cap 1: B is the only terminal and stays.
  expect(registry.isTerminal(fabId, 'B')).toBe(true);
  registry.observe(result('A', 2, 'succeeded'));
  // Completion order is B then A, so A (the most recently completed) must be
  // retained and the earlier completion of B evicted. The old Map-insertion
  // implementation evicted A because its first revision arrived first.
  expect(registry.isTerminal(fabId, 'A')).toBe(true);
  expect(registry.lastObservedRevision(fabId, 'A')).toBe(2);
  expect(registry.isTerminal(fabId, 'B')).toBeUndefined();
  expect(registry.lastObservedRevision(fabId, 'B')).toBeUndefined();
  expect(registry.size).toBe(1);
  expect(registry.terminalCount).toBe(1);
});

it('keeps the most recently completed terminals when several are evicted', () => {
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 2, terminalTtlMs: 0 });
  registry.observe(result('running', 1, 'executing'));
  registry.observe(result('done-1', 2, 'succeeded'));
  registry.observe(result('done-2', 2, 'succeeded'));
  registry.observe(result('done-3', 2, 'succeeded')); // evicts done-1
  registry.observe(result('running', 2, 'succeeded')); // evicts done-2
  expect(registry.isTerminal(fabId, 'done-3')).toBe(true);
  expect(registry.isTerminal(fabId, 'running')).toBe(true);
  expect(registry.isTerminal(fabId, 'done-1')).toBeUndefined();
  expect(registry.isTerminal(fabId, 'done-2')).toBeUndefined();
  expect(registry.terminalCount).toBe(2);
});

it('enforces maxEntries as a hard cap even when every entry is active (R4-08)', () => {
  const registry = new CommandCorrelationRegistry({ maxEntries: 2, maxTerminalEntries: 8, terminalTtlMs: 0 });
  for (let index = 0; index < 5; index += 1) registry.observe(result('active-' + index, 1, 'executing'));
  // Bounded memory beats an unbounded registry: with only active entries the
  // oldest active watermarks are evicted instead of silently breaking the cap.
  expect(registry.size).toBe(2);
  expect(registry.terminalCount).toBe(0);
  expect(registry.lastObservedRevision(fabId, 'active-0')).toBeUndefined();
  expect(registry.lastObservedRevision(fabId, 'active-1')).toBeUndefined();
  expect(registry.lastObservedRevision(fabId, 'active-2')).toBeUndefined();
  expect(registry.lastObservedRevision(fabId, 'active-3')).toBe(1);
  expect(registry.lastObservedRevision(fabId, 'active-4')).toBe(1);
  // Terminal entries are sacrificed before active ones under the hard cap.
  registry.observe(result('done', 2, 'succeeded'));
  expect(registry.isTerminal(fabId, 'done')).toBeUndefined();
  expect(registry.size).toBe(2);
  expect(registry.isTerminal(fabId, 'active-3')).toBe(false);
  expect(registry.isTerminal(fabId, 'active-4')).toBe(false);
});

it('tracks observed and applied revisions separately and only advances applied forward (R4-03)', () => {
  const registry = new CommandCorrelationRegistry();
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBeUndefined();
  registry.observe(result('cmd', 3, 'executing'));
  expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(3);
  expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
  // Observed is not applied: only an actor-proven advance sets the applied watermark.
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBeUndefined();
  registry.markApplied(result('cmd', 2, 'executing'));
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
  // Forward-only: an older authoritative re-application cannot regress it.
  registry.markApplied(result('cmd', 1, 'accepted'));
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
  // R5.1: the applied watermark only advances for the recorded outcome. The
  // wire observation of revision 3 was 'executing', so an ordinary 'succeeded'
  // frame cannot prove application; authority must correct the record first.
  registry.markApplied(result('cmd', 3, 'succeeded'));
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
  expect(registry.observeAuthoritative(result('cmd', 3, 'succeeded'))).toBe('new');
  registry.markApplied(result('cmd', 3, 'succeeded'));
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(3);
  // A newer observation keeps coverage while the observed watermark advances.
  registry.observe(result('cmd', 4, 'executing'));
  expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(4);
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(3);
  expect(registry.appliedRevision(fabId, 'cmd')).toBe(3);
  registry.clear();
  expect(registry.lastObservedRevision(fabId, 'cmd')).toBeUndefined();
  expect(registry.lastAppliedRevision(fabId, 'cmd')).toBeUndefined();
});

it('R4-07: invalid correlation retention options fail fast at construction', () => {
  expect(() => new CommandCorrelationRegistry({ maxEntries: 0 })).toThrow(CommandConfigurationError);
  expect(() => new CommandCorrelationRegistry({ maxEntries: Number.NaN })).toThrow(CommandConfigurationError);
  expect(() => new CommandCorrelationRegistry({ maxTerminalEntries: Number.POSITIVE_INFINITY })).toThrow(
    CommandConfigurationError,
  );
  expect(() => new CommandCorrelationRegistry({ terminalTtlMs: -1 })).toThrow(CommandConfigurationError);
  expect(() => new CommandCorrelationRegistry({ now: 42 as unknown as () => number })).toThrow(CommandConfigurationError);
});

it('retains duplicate/stale decisions and TTL sweeps without touching active commands', () => {
  let now = 0;
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 8, terminalTtlMs: 100, now: () => now });
  expect(registry.observe(result('active', 1, 'executing'))).toBe('new');
  expect(registry.observe(result('active', 1, 'executing'))).toBe('duplicate');
  // Round 5.2 / review P1-01: rev0 was never observed, so its outcome cannot be
  // proven. An old revision is not a harmless duplicate without that proof.
  expect(registry.observe(result('active', 0, 'accepted'))).toBe('stale-unverified');
  expect(registry.observe(result('done', 2, 'succeeded'))).toBe('new');
  // Same revision with a different outcome is a conflict; the recorded outcome
  // is not mutated by an ordinary observation.
  expect(registry.observe(result('done', 2, 'failed'))).toBe('conflict');
  expect(registry.lastObservedRevision(fabId, 'done')).toBe(2);
  expect(registry.lastObservedOutcome(fabId, 'done')).toBe('succeeded');
  now = 50;
  expect(registry.sweep()).toBe(0);
  now = 100;
  expect(registry.sweep()).toBe(1);
  expect(registry.isTerminal(fabId, 'done')).toBeUndefined();
  expect(registry.isTerminal(fabId, 'active')).toBe(false);
  registry.clear();
  expect(registry.size).toBe(0);
  expect(registry.terminalCount).toBe(0);
});

it('stays O(1) per observe while thousands of active commands accumulate', () => {
  const registry = new CommandCorrelationRegistry();
  const started = performance.now();
  for (let index = 0; index < 4_000; index += 1) {
    expect(registry.observe(result('cmd-' + index, 1, 'executing'))).toBe('new');
  }
  const elapsed = performance.now() - started;
  // Audited implementation took ~367ms for 4,000 active commands because every
  // event expanded and re-filtered the whole retained Map. The O(1) index must
  // stay far below that; the bound is deliberately generous against CI noise.
  expect(elapsed).toBeLessThan(250);
  expect(registry.size).toBe(4_000);
  expect(registry.terminalCount).toBe(0);
  // The default hard cap (4096) is not reached by 4001 entries: no eviction.
  registry.observe(result('done', 2, 'succeeded'));
  expect(registry.isTerminal(fabId, 'done')).toBe(true);
  expect(registry.size).toBe(4_001);
});

describe('Round 5.1 / P1-02 correlation revision+outcome invariant', () => {
  it('spec §4.4: rev3 accepted -> rev3 accepted is a duplicate', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('new');
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('duplicate');
    expect(registry.size).toBe(1);
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(3);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('accepted');
  });

  it('spec §4.4: rev3 accepted -> rev3 failed is a conflict with no record mutation', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('new');
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('conflict');
    // The conflict is reported, never accepted as a new observation.
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(3);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('accepted');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(false);
    expect(registry.terminalCount).toBe(0);
    expect(registry.size).toBe(1);
    // Repeated conflicting frames stay conflicts; nothing changes.
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('conflict');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('accepted');
  });

  it('spec §4.4: rev3 executing -> rev3 succeeded is a conflict, not a terminal transition', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'executing'))).toBe('new');
    expect(registry.observe(result('cmd', 3, 'succeeded'))).toBe('conflict');
    // An ordinary conflicting event may not flip the terminal bookkeeping.
    expect(registry.isTerminal(fabId, 'cmd')).toBe(false);
    expect(registry.terminalCount).toBe(0);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
  });

  it('occurredAt never participates in correlation decisions', () => {
    const registry = new CommandCorrelationRegistry();
    const first = commandResult({ fabId, commandId: 'cmd', revision: 3, outcome: 'accepted', occurredAt: '2026-01-01T00:00:00.000Z' });
    const second = commandResult({ fabId, commandId: 'cmd', revision: 3, outcome: 'accepted', occurredAt: '2026-01-02T00:00:00.000Z' });
    expect(registry.observe(first)).toBe('new');
    expect(registry.observe(second)).toBe('duplicate');
  });

  it('records the outcome of the current highest observed revision', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 1, 'accepted'))).toBe('new');
    expect(registry.observe(result('cmd', 2, 'executing'))).toBe('new');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
    expect(registry.observe(result('cmd', 3, 'succeeded'))).toBe('new');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('succeeded');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
    // Older revisions stay stale and never roll the outcome back.
    expect(registry.observe(result('cmd', 2, 'executing'))).toBe('stale');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('succeeded');
  });
});

describe('Round 5.1 / P1-02 authoritative resolution and correction', () => {
  it('authoritative same revision resolves a conflict and records the authoritative outcome', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('new');
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('conflict');
    // Authority corrects the recorded outcome at the same revision.
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('new');
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(3);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('failed');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
    expect(registry.terminalCount).toBe(1);
    // The corrected record now treats the authoritative outcome as duplicate and
    // the superseded realtime outcome as a new conflict.
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('duplicate');
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('conflict');
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('duplicate');
  });

  it('authoritative same revision with the same outcome is a duplicate', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'executing'))).toBe('new');
    expect(registry.observeAuthoritative(result('cmd', 3, 'executing'))).toBe('duplicate');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
  });

  it('authoritative higher revision converges and preserves the applied watermark', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 2, 'executing'))).toBe('new');
    registry.markApplied(result('cmd', 2, 'executing'));
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
    expect(registry.observeAuthoritative(result('cmd', 5, 'succeeded'))).toBe('new');
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(5);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('succeeded');
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
    expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
    expect(registry.terminalCount).toBe(1);
    expect(registry.hasUnappliedObservation(fabId, 'cmd')).toBe(true);
  });

  it('authoritative lower revision is stale with no revision/outcome rollback', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 5, 'succeeded'))).toBe('new');
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('stale');
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(5);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('succeeded');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
    expect(registry.terminalCount).toBe(1);
  });

  it('active -> terminal same-revision correction keeps terminal bookkeeping coherent', () => {
    const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 2, terminalTtlMs: 0 });
    expect(registry.observe(result('cmd', 3, 'executing'))).toBe('new');
    expect(registry.terminalCount).toBe(0);
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('new');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
    expect(registry.terminalCount).toBe(1);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('failed');
    // The terminal TTL sweep must still see the corrected entry.
    expect(registry.sweep()).toBe(0);
    // ... and the terminal cap must be able to evict it.
    expect(registry.observe(result('other', 1, 'succeeded'))).toBe('new');
    expect(registry.terminalCount).toBe(2);
    expect(registry.observe(result('third', 1, 'succeeded'))).toBe('new');
    expect(registry.terminalCount).toBe(2);
    expect(registry.isTerminal(fabId, 'cmd')).toBeUndefined();
  });

  it('terminal -> active same-revision correction restores active retention', () => {
    const registry = new CommandCorrelationRegistry({ terminalTtlMs: 0 });
    expect(registry.observe(result('cmd', 3, 'succeeded'))).toBe('new');
    expect(registry.terminalCount).toBe(1);
    // Authority says the command is still active: correct the recorded outcome
    // in place; it must stop counting as a terminal.
    expect(registry.observeAuthoritative(result('cmd', 3, 'executing'))).toBe('new');
    expect(registry.isTerminal(fabId, 'cmd')).toBe(false);
    expect(registry.terminalCount).toBe(0);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
    // The lazy terminal-order queue must not resurrect/duplicate the entry.
    expect(registry.sweep()).toBe(0);
    expect(registry.terminalCount).toBe(0);
    expect(registry.isTerminal(fabId, 'cmd')).toBe(false);
  });

  it('terminal -> terminal same-revision correction keeps one completion entry', () => {
    let now = 0;
    const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 2, terminalTtlMs: 100, now: () => now });
    expect(registry.observe(result('cmd', 3, 'succeeded'))).toBe('new');
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('new');
    expect(registry.terminalCount).toBe(1);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('failed');
    // The completion order entry remained valid: TTL from the corrected terminal.
    now = 60;
    expect(registry.sweep()).toBe(0);
    now = 100;
    expect(registry.sweep()).toBe(1);
    expect(registry.isTerminal(fabId, 'cmd')).toBeUndefined();
    expect(registry.terminalCount).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('markApplied refuses an outcome that disagrees with the recorded observation', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('new');
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('conflict');
    // An ordinary conflicting event can never advance the applied watermark.
    registry.markApplied(result('cmd', 3, 'failed'));
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBeUndefined();
    // The matching recorded outcome can.
    registry.markApplied(result('cmd', 3, 'accepted'));
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(3);
    // Forward-only: the refused conflicting event still cannot regress it.
    registry.markApplied(result('cmd', 3, 'failed'));
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(3);
  });

  it('markApplied defensively observes a missing entry', () => {
    const registry = new CommandCorrelationRegistry();
    registry.markApplied(result('cmd', 2, 'executing'));
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(2);
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('executing');
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
  });

  it('lastObservedOutcome is undefined for an unknown command', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.lastObservedOutcome(fabId, 'missing')).toBeUndefined();
  });
});

describe('Round 5.2 / review P1-01: bounded revision outcome history', () => {
  it('flags an old revision with a conflicting outcome as a conflict instead of a stale duplicate', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 1, 'accepted'))).toBe('new');
    expect(registry.markApplied(result('cmd', 1, 'accepted'))).toBe(true);
    expect(registry.observe(result('cmd', 2, 'executing'))).toBe('new');
    expect(registry.markApplied(result('cmd', 2, 'executing'))).toBe(true);

    // rev1 was recorded and applied as 'accepted'. A replay of rev1 with a different
    // outcome violates the revision invariant; it must be a conflict, never stale.
    expect(registry.observe(result('cmd', 1, 'failed'))).toBe('conflict');
    expect(registry.recordedOutcome(fabId, 'cmd', 1)).toBe('accepted');
    expect(registry.provesApplied(result('cmd', 1, 'accepted'))).toBe(true);
    expect(registry.provesApplied(result('cmd', 1, 'failed'))).toBe(false);
    expect(registry.hasUnappliedObservation(fabId, 'cmd')).toBe(false);
  });

  it('treats an old revision with no retained outcome as stale-unverified, never as a duplicate', () => {
    const registry = new CommandCorrelationRegistry();
    registry.observe(result('cmd', 3, 'executing'));
    // rev2 was never observed: no proof exists for its outcome.
    expect(registry.observe(result('cmd', 2, 'executing'))).toBe('stale-unverified');
    expect(registry.recordedOutcome(fabId, 'cmd', 2)).toBeUndefined();
    expect(registry.provesApplied(result('cmd', 2, 'executing'))).toBe(false);
    // The record is untouched and the current revision stays verifiable.
    expect(registry.lastObservedRevision(fabId, 'cmd')).toBe(3);
    expect(registry.observe(result('cmd', 3, 'executing'))).toBe('duplicate');
  });

  it('verifies a stale duplicate only when the retained outcome matches', () => {
    const registry = new CommandCorrelationRegistry();
    registry.observe(result('cmd', 1, 'accepted'));
    expect(registry.markApplied(result('cmd', 1, 'accepted'))).toBe(true);
    registry.observe(result('cmd', 2, 'executing'));
    expect(registry.markApplied(result('cmd', 2, 'executing'))).toBe(true);

    expect(registry.observe(result('cmd', 1, 'accepted'))).toBe('stale');
    expect(registry.provesApplied(result('cmd', 1, 'accepted'))).toBe(true);
  });

  it('bounds the history smallest-first and degrades pruned revisions to stale-unverified', () => {
    const registry = new CommandCorrelationRegistry();
    for (let revision = 1; revision <= 40; revision += 1) {
      expect(registry.observe(result('cmd', revision, 'executing'))).toBe('new');
    }
    expect(registry.recordedOutcome(fabId, 'cmd', 1)).toBeUndefined();
    expect(registry.recordedOutcome(fabId, 'cmd', 40)).toBe('executing');
    expect(registry.observe(result('cmd', 1, 'executing'))).toBe('stale-unverified');
    expect(registry.observe(result('cmd', 40, 'executing'))).toBe('duplicate');
  });
});

describe('Round 5.2 / review P1-02: applied identity = (revision, outcome)', () => {
  it('an authoritative outcome correction invalidates the old applied proof until the actor re-proves it', () => {
    const registry = new CommandCorrelationRegistry();
    expect(registry.observe(result('cmd', 3, 'accepted'))).toBe('new');
    expect(registry.markApplied(result('cmd', 3, 'accepted'))).toBe(true);
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(3);
    expect(registry.lastAppliedOutcome(fabId, 'cmd')).toBe('accepted');
    expect(registry.hasUnappliedObservation(fabId, 'cmd')).toBe(false);

    // Authority corrects revision 3 to failed. The actor has only ever proven the
    // OLD outcome, so the applied identity must no longer claim the new one.
    expect(registry.observeAuthoritative(result('cmd', 3, 'failed'))).toBe('new');
    expect(registry.lastObservedOutcome(fabId, 'cmd')).toBe('failed');
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
    expect(registry.lastAppliedOutcome(fabId, 'cmd')).toBeUndefined();
    expect(registry.hasUnappliedObservation(fabId, 'cmd')).toBe(true);
    expect(registry.provesApplied(result('cmd', 3, 'failed'))).toBe(false);
    // A duplicate of the corrected outcome is still not proven.
    expect(registry.observe(result('cmd', 3, 'failed'))).toBe('duplicate');
    expect(registry.provesApplied(result('cmd', 3, 'failed'))).toBe(false);
    // The authoritative re-application proves the corrected identity.
    expect(registry.markApplied(result('cmd', 3, 'failed'))).toBe(true);
    expect(registry.provesApplied(result('cmd', 3, 'failed'))).toBe(true);
    expect(registry.hasUnappliedObservation(fabId, 'cmd')).toBe(false);
    expect(registry.lastAppliedOutcome(fabId, 'cmd')).toBe('failed');
  });

  it('markApplied reports whether the identity is proven and never advances on an old or mismatched event', () => {
    const registry = new CommandCorrelationRegistry();
    registry.observe(result('cmd', 1, 'accepted'));
    expect(registry.markApplied(result('cmd', 1, 'accepted'))).toBe(true);
    registry.observe(result('cmd', 2, 'executing'));
    expect(registry.markApplied(result('cmd', 2, 'executing'))).toBe(true);
    expect(registry.markApplied(result('cmd', 1, 'accepted'))).toBe(false);
    expect(registry.markApplied(result('cmd', 2, 'failed'))).toBe(false);
    expect(registry.lastAppliedRevision(fabId, 'cmd')).toBe(2);
    expect(registry.lastAppliedOutcome(fabId, 'cmd')).toBe('executing');
  });
});

