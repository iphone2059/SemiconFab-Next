import { expect, it } from 'vitest';
import { CommandCorrelationRegistry } from '@/runtime/command-correlation-registry';
import { commandResult } from '../support/command-fakes.ts';

const fabId = 'fab-a';
const result = (commandId: string, revision: number, outcome: Parameters<typeof commandResult>[0]['outcome']) =>
  commandResult({ fabId, commandId, revision, outcome });

it('evicts the oldest *completed* terminal, not the longest-running one that finishes last', () => {
  // Audited scenario: A starts running first, B completes, then A completes last.
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 1, terminalTtlMs: 0 });
  registry.observe(result('A', 1, 'executing'));
  registry.markApplied(result('A', 1, 'executing'));
  registry.observe(result('B', 2, 'succeeded'));
  registry.markApplied(result('B', 2, 'succeeded'));
  // Terminal cap 1: B is the only terminal and stays.
  expect(registry.isTerminal(fabId, 'B')).toBe(true);
  registry.observe(result('A', 2, 'succeeded'));
  registry.markApplied(result('A', 2, 'succeeded'));
  // Completion order is B then A, so A (the most recently completed) must be
  // retained and the earlier completion of B evicted. The old Map-insertion
  // implementation evicted A because its first revision arrived first.
  expect(registry.isTerminal(fabId, 'A')).toBe(true);
  expect(registry.lastRevision(fabId, 'A')).toBe(2);
  expect(registry.isTerminal(fabId, 'B')).toBeUndefined();
  expect(registry.lastRevision(fabId, 'B')).toBeUndefined();
  expect(registry.size).toBe(1);
  expect(registry.terminalCount).toBe(1);
});

it('keeps the most recently completed terminals when several are evicted', () => {
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 2, terminalTtlMs: 0 });
  registry.observe(result('running', 1, 'executing'));
  registry.markApplied(result('running', 1, 'executing'));
  registry.observe(result('done-1', 2, 'succeeded'));
  registry.markApplied(result('done-1', 2, 'succeeded'));
  registry.observe(result('done-2', 2, 'succeeded'));
  registry.markApplied(result('done-2', 2, 'succeeded'));
  registry.observe(result('done-3', 2, 'succeeded'));
  registry.markApplied(result('done-3', 2, 'succeeded'));
  registry.observe(result('running', 2, 'succeeded'));
  registry.markApplied(result('running', 2, 'succeeded'));
  expect(registry.isTerminal(fabId, 'done-3')).toBe(true);
  expect(registry.isTerminal(fabId, 'running')).toBe(true);
  expect(registry.isTerminal(fabId, 'done-1')).toBeUndefined();
  expect(registry.isTerminal(fabId, 'done-2')).toBeUndefined();
  expect(registry.terminalCount).toBe(2);
});

it('never evicts active commands for the absolute maxEntries cap', () => {
  const registry = new CommandCorrelationRegistry({ maxEntries: 2, maxTerminalEntries: 8, terminalTtlMs: 0 });
  for (let index = 0; index < 5; index += 1) {
    registry.observe(result('active-' + index, 1, 'executing'));
    registry.markApplied(result('active-' + index, 1, 'executing'));
  }
  expect(registry.size).toBe(5);
  expect(registry.terminalCount).toBe(0);
  for (let index = 0; index < 5; index += 1) expect(registry.lastRevision(fabId, 'active-' + index)).toBe(1);
  // A terminal entry beyond maxEntries is evicted, the active commands stay.
  registry.observe(result('done', 2, 'succeeded'));
  expect(registry.isTerminal(fabId, 'done')).toBeUndefined();
  expect(registry.size).toBe(5);
  expect(registry.isTerminal(fabId, 'active-0')).toBe(false);
});

it('separates observed revisions from revisions proven applied to the actor', () => {
  const registry = new CommandCorrelationRegistry();
  const event = result('cmd', 4, 'succeeded');
  expect(registry.observe(event)).toBe('new');
  expect(registry.lastRevision(fabId, 'cmd')).toBe(4);
  expect(registry.isApplied(event)).toBe(false);
  expect(registry.isTerminal(fabId, 'cmd')).toBeUndefined();
  registry.markApplied(event);
  expect(registry.isApplied(event)).toBe(true);
  expect(registry.isTerminal(fabId, 'cmd')).toBe(true);
});

it('retains duplicate/stale decisions and TTL sweeps without touching active commands', () => {
  let now = 0;
  const registry = new CommandCorrelationRegistry({ maxTerminalEntries: 8, terminalTtlMs: 100, now: () => now });
  expect(registry.observe(result('active', 1, 'executing'))).toBe('new');
  registry.markApplied(result('active', 1, 'executing'));
  expect(registry.observe(result('active', 1, 'executing'))).toBe('duplicate');
  expect(registry.observe(result('active', 0, 'accepted'))).toBe('stale');
  expect(registry.observe(result('done', 2, 'succeeded'))).toBe('new');
  registry.markApplied(result('done', 2, 'succeeded'));
  expect(registry.observe(result('done', 2, 'failed'))).toBe('duplicate');
  expect(registry.lastRevision(fabId, 'done')).toBe(2);
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
  // A terminal added afterwards evicts only itself (per-event bound enforcement).
  registry.observe(result('done', 2, 'succeeded'));
  registry.markApplied(result('done', 2, 'succeeded'));
  expect(registry.isTerminal(fabId, 'done')).toBe(true);
  expect(registry.size).toBe(4_001);
});
