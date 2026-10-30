// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { createTestRuntime, type AppRuntime } from '../../support/resource-test-runtime.tsx';

/**
 * 矩阵 7c / CR-10 (ADR-013 §1.4) + R3-06 (Round 3 static spec §7): every polling
 * async branch (success fork, rejected fork, owner-fiber termination, retry timer,
 * scope close) must prove it still owns the CURRENT generation (entry alive,
 * polling intent, same scopeGeneration, same ResourceScope) before mutating owner
 * state. A stale generation rejection must never reset a newer generation; the
 * current generation has an explicit, bounded termination policy:
 * clear owner + one safe retry + bounded control diagnostic, never polling=true
 * without an active owner. 1000 retain/release interleavings must never leave a
 * stale owner or a duplicate polling loop.
 *
 * Round 3 is a static phase: the source-assertion test below is written but not
 * executed here; behavioral verification of the retry/termination path is a
 * deferred verification item (it needs the next run phase).
 */
// jsdom's import.meta.url is not a file URL; the manager source is resolved from the vitest cwd.
const MANAGER_SOURCE = readFileSync(resolve(process.cwd(), 'src/api/resource-manager.ts'), 'utf8');

const runtimes: AppRuntime<never>[] = [];
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

const polledDefinition = (onLoad: () => void) => defineResource({
  identity: { kind: 'poll-probe', version: 1, key: 'poll-probe' },
  load: Effect.suspend(() => {
    onLoad();
    return Effect.succeed(onLoad);
  }),
  policy: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 20 },
});

it('validates entry/polling/generation/scope identity in the fork callback and releases the generation', () => {
  expect(MANAGER_SOURCE, 'fork callback must capture the started generation').toMatch(/startedGeneration/);
  expect(MANAGER_SOURCE, 'fork callback must capture the started scope identity').toMatch(/startedScope = entry\.scope|const scope = entry\.scope/);
  expect(MANAGER_SOURCE, 'fork callback must compare the generation').toMatch(/entry\.scopeGeneration !== startedGeneration/);
  expect(MANAGER_SOURCE, 'fork callback must compare the scope identity').toMatch(/entry\.scope !== scope/);
  expect(MANAGER_SOURCE, 'stale fork callbacks must be interrupted').toMatch(/interrupt\(fiber\)/);
  expect(MANAGER_SOURCE, 'release increments the scope generation').toMatch(/entry\.scopeGeneration \+= 1/);
});

it('R3-06: rejected fork / terminated owner fiber is generation-guarded, bounded and policy-explicit', () => {
  // One ownership predicate shared by the then/catch/fiber-exit branches.
  expect(MANAGER_SOURCE).toMatch(
    /const isCurrentPollOwner = \(entry: ManagerEntry, startedGeneration: number, scope: Scope\.Closeable\): boolean =>/,
  );
  expect(MANAGER_SOURCE, 'ownership predicate checks entry/polling/generation/scope').toMatch(
    /!entry\.removed &&[\s\S]{0,200}?!isDisposed\(\) &&[\s\S]{0,200}?entry\.polling &&[\s\S]{0,200}?entry\.scopeGeneration === startedGeneration &&[\s\S]{0,200}?entry\.scope === scope/,
  );
  // A rejected fork routes through the guarded termination helper; no bare reset.
  expect(MANAGER_SOURCE, 'fork rejection must use the generation-guarded termination path').toMatch(
    /\.catch\(\(cause\) => \{[\s\S]{0,600}?terminatePollOwner\(entry, startedGeneration, scope, 'fork-rejected', cause\);/,
  );
  expect(MANAGER_SOURCE, 'a stale fork rejection must not reset polling directly').not.toMatch(
    /catch\(\(\) => \{ entry\.polling = false; \}\)/,
  );
  // A stored owner fiber's termination is observed and feeds the same guard.
  expect(MANAGER_SOURCE, 'owner fiber termination must be observed').toMatch(
    /host\.services\.runPromise\(Fiber\.await\(fiber\)\)/,
  );
  expect(MANAGER_SOURCE, 'fiber termination routes through the guarded termination path').toMatch(
    /terminatePollOwner\(\s+entry,\s+startedGeneration,\s+scope,\s+'fiber-terminated',/,
  );
  // Explicit current-generation termination policy: owner cleared synchronously,
  // bounded retry budget, bounded control diagnostics, no silent unbounded retry.
  expect(MANAGER_SOURCE, 'termination clears the owner without awaiting').toMatch(
    /entry\.polling = false;\r?\n\s+entry\.pollFiber = undefined;/,
  );
  expect(MANAGER_SOURCE).toMatch(/if \(!canRetry\) return;/);
  expect(MANAGER_SOURCE).toMatch(/const MAX_POLL_RETRIES = 1;/);
  expect(MANAGER_SOURCE).toMatch(/const MAX_POLL_DIAGNOSTICS = 32;/);
  expect(MANAGER_SOURCE, 'control diagnostics ring is bounded').toMatch(
    /pollDiagnostics\.splice\(0, pollDiagnostics\.length - MAX_POLL_DIAGNOSTICS\)/,
  );
  expect(MANAGER_SOURCE, 'bounded control diagnostic is stored on the entry').toMatch(
    /entry\.lastDiagnostic = diagnostic;/,
  );
  // The retry timer re-validates the captured generation/scope and is cleared by release paths.
  expect(MANAGER_SOURCE, 'retry timer re-checks the captured generation and scope').toMatch(
    /entry\.scope !== scope \|\| entry\.scopeGeneration !== startedGeneration/,
  );
  expect(MANAGER_SOURCE, 'retry timer is cleared on release/stop').toMatch(/clearPollRetryTimer\(entry\)/);
  // Closing a ResourceScope can never leave polling=true without an owner.
  expect(MANAGER_SOURCE, 'scope close defensively stops a lingering owner').toMatch(
    /if \(entry\.polling \|\| entry\.pollFiber \|\| entry\.pollRetryTimer\) stopPolling\(entry\);/,
  );
  // The outcome is explicit in the bounded diagnostic (retry vs stop).
  expect(MANAGER_SOURCE).toMatch(/action: canRetry \? 'retry-scheduled' : 'stopped'/);
});

it('1000 interleaved retain/release cycles leave exactly one poll owner and no stale fiber', async () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  const manager = runtime.resources;
  let loads = 0;
  const handle = manager.handle(polledDefinition(() => { loads += 1; }));

  for (let index = 0; index < 1_000; index += 1) {
    const release = manager.retain(handle);
    if (index % 13 === 0) await Promise.resolve();
    release();
    if (index % 7 === 0) await Promise.resolve();
    expect(manager.stats.polling, 'a single resource key can never report two poll owners').toBeLessThanOrEqual(1);
  }
  expect(manager.stats.polling, 'all released cycles stop their poll owner').toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(manager.stats.polling, 'no stale released fiber revives polling').toBe(0);

  // One final owner: exactly one poll per interval (a stale loop would double this).
  const release = manager.retain(handle);
  await vi.advanceTimersByTimeAsync(1);
  expect(manager.stats.polling).toBe(1);
  const afterMount = loads;
  await vi.advanceTimersByTimeAsync(20);
  expect(loads - afterMount, 'one poll owner means one poll per period').toBe(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(loads - afterMount).toBe(2);
  expect(manager.stats.polling).toBe(1);
  release();
  const afterRelease = loads;
  await vi.advanceTimersByTimeAsync(100);
  expect(loads, 'releasing the last subscriber stops the single poll loop').toBe(afterRelease);
  expect(manager.stats.polling).toBe(0);
  expect(manager.stats.scopes).toBe(0);
});

it('dispose leaves zero active poll owners and no further loads', async () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  let loads = 0;
  const handle = manager.handle(polledDefinition(() => { loads += 1; }));
  const release = manager.retain(handle);
  await vi.advanceTimersByTimeAsync(1);
  expect(manager.stats.polling).toBe(1);
  release();
  await runtime.dispose();
  expect(manager.stats.polling).toBe(0);
  expect(manager.stats.entries).toBe(0);
  const before = loads;
  await vi.advanceTimersByTimeAsync(200);
  expect(loads).toBe(before);
});