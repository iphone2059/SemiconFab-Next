import { afterEach, expect, it, vi } from 'vitest';
import { ensureResource, invalidateResource, makeResource, resourceValue, setResourceValue } from '@/api/resource';
import { equipmentStatusResource } from '@/api/equipment.resource';
import { runsResource, runResource } from '@/api/runs.resource';
import { Effect } from 'effect';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

const site = 'site-1';
const fabA = 'fab-a';
const fabB = 'fab-b';
const snapshot = (fabId: string, sequence: number) => ({
  siteId: site, fabId, generatedAt: '2026-10-27T00:00:0' + sequence + 'Z', sequence, epoch: 1,
  tools: [{ state: 'running' }],
} as never);
afterEach(() => vi.unstubAllGlobals());

it('RES-05: explicit invalidation refreshes only the affected resource', async () => {
  const runtime = createTestRuntime();
  let loads = 0;
  const a = makeResource(Effect.suspend(() => { loads += 1; return Effect.succeed('a' + loads); }), { freshnessMs: 0, idleTtlMs: 300_000 });
  const b = makeResource(Effect.suspend(() => { loads += 100; return Effect.succeed('b' + loads); }), { freshnessMs: 0, idleTtlMs: 300_000 });
  setResourceValue(runtime, a, 'seeded-a');
  setResourceValue(runtime, b, 'seeded-b');
  invalidateResource(runtime, a);
  await expect.poll(() => resourceValue(runtime.registry, a)).toBe('a1');
  expect(resourceValue(runtime.registry, b)).toBe('seeded-b');
  expect(loads).toBe(1);
  runtime.dispose();
});

it('RES-06: FAB-scoped resource identities never share state', () => {
  const runtime = createTestRuntime();
  setResourceValue(runtime, equipmentStatusResource(site, fabA), snapshot(fabA, 9));
  setResourceValue(runtime, equipmentStatusResource(site, fabB), snapshot(fabB, 1));
  expect(resourceValue(runtime.registry, equipmentStatusResource(site, fabA))?.sequence).toBe(9);
  expect(resourceValue(runtime.registry, equipmentStatusResource(site, fabB))?.sequence).toBe(1);
  expect(equipmentStatusResource(site, fabA)).not.toBe(equipmentStatusResource(site, fabB));
  runtime.dispose();
});

it('RES-07: run family identity is deterministic and independent per run id', () => {
  expect(runResource('run-a')).toBe(runResource('run-a'));
  expect(runResource('run-a')).not.toBe(runResource('run-b'));
  expect(runsResource.policy.pollMs).toBe(1500);
});

it('RES-08: a failed refresh retains the previous success while reporting the typed error', async () => {
  const runtime = createTestRuntime();
  let calls = 0;
  const resource = makeResource(Effect.suspend(() => {
    calls += 1;
    return calls === 1 ? Effect.succeed('old') : Effect.fail(new Error('boom'));
  }), { freshnessMs: 0, idleTtlMs: 300_000 });
  await ensureResource(runtime, resource);
  await expect(ensureResource(runtime, resource)).rejects.toThrow('boom');
  expect(runtime.registry.get(resource.atom)._tag).toBe('Failure');
  expect(resourceValue(runtime.registry, resource)).toBe('old');
  runtime.dispose();
});
