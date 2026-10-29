import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { equipmentStatusDefinition, equipmentStatusKey } from '@/api/equipment.resource';
import { runKey, runResultsKey, runsDefinition } from '@/api/runs.resource';
import { Effect } from 'effect';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

const site = 'site-1';
const fabA = 'fab-a';
const fabB = 'fab-b';
const snapshot = (fabId: string, sequence: number) => ({
  siteId: site, fabId, generatedAt: '2026-10-27T00:00:0' + (sequence % 10) + 'Z', sequence, epoch: 1,
  tools: FAB_LAYOUT.map(() => ({ state: 'running' })),
}) as never;
afterEach(() => vi.unstubAllGlobals());

it('RES-05: explicit invalidation refreshes only the affected resource', async () => {
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  let loads = 0;
  const makeDefinition = (key: string) => defineResource({
    identity: { kind: 'cache-probe', version: 1, key },
    load: Effect.suspend(() => { loads += 1; return Effect.succeed(key + ':' + loads); }),
    policy: { freshnessMs: 0, idleTtlMs: 300_000 },
  });
  const a = manager.handle(makeDefinition('a'));
  const b = manager.handle(makeDefinition('b'));
  manager.publish(a, 'seeded-a', 'recovery');
  manager.publish(b, 'seeded-b', 'recovery');
  await manager.refresh(a);
  expect(manager.value(a)).toBe('a:1');
  expect(manager.value(b)).toBe('seeded-b');
  expect(loads).toBe(1);
  await runtime.dispose();
});

it('RES-06: FAB-scoped resource identities never share state', () => {
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  const handleA = manager.handle(equipmentStatusDefinition(site, fabA));
  const handleB = manager.handle(equipmentStatusDefinition(site, fabB));
  manager.publish(handleA, snapshot(fabA, 9), 'recovery');
  manager.publish(handleB, snapshot(fabB, 1), 'recovery');
  expect(manager.value(handleA)?.sequence).toBe(9);
  expect(manager.value(handleB)?.sequence).toBe(1);
  expect(equipmentStatusKey(site, fabA)).not.toBe(equipmentStatusKey(site, fabB));
  expect(handleA.atom).not.toBe(handleB.atom);
  runtime.dispose();
});

it('RES-07: dynamic run identity keys are deterministic and independent per run id', () => {
  expect(runKey('run-a')).toBe(runKey('run-a'));
  expect(runKey('run-a')).not.toBe(runKey('run-b'));
  expect(runResultsKey('run-a')).not.toBe(runKey('run-a'));
  expect(runsDefinition.policy.pollMs).toBe(1500);
});

it('RES-08: a failed refresh retains the previous success while reporting the typed error', async () => {
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  let calls = 0;
  const definition = defineResource({
    identity: { kind: 'retained-failure', version: 1, key: 'retained-failure' },
    load: Effect.suspend(() => {
      calls += 1;
      return calls === 1 ? Effect.succeed('old') : Effect.fail(new Error('boom'));
    }),
    policy: { freshnessMs: 0, idleTtlMs: 300_000 },
  });
  const handle = manager.handle(definition);
  await manager.ensure(handle);
  await expect(manager.refresh(handle)).rejects.toThrow('boom');
  expect(manager.state(handle)._tag).toBe('Failure');
  expect(manager.value(handle)).toBe('old');
  await runtime.dispose();
});