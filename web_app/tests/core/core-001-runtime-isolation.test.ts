import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-001 (INV-01): the same ResourceDefinition used by two independent
 * AppRuntimes must never share request coordination, Atom values or
 * cancellation. The previous module-level WeakMap<Resource, Promise> failed this
 * (see docs/architecture/evidence/phase-b-resource.md RED section).
 */
const runtimes: AppRuntime<never>[] = [];
const runtime = (): AppRuntime<never> => {
  const value = createTestRuntime();
  runtimes.push(value);
  return value;
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const controlledDefinition = (loads: Deferred<number>[]) => defineResource({
  key: 'shared-key',
  load: Effect.suspend(() => {
    const gate = deferred<number>();
    loads.push(gate);
    return Effect.tryPromise({ try: () => gate.promise, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
  }),
  policy: { freshnessMs: 0, idleTtlMs: 300_000 },
});

afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.unstubAllGlobals();
});

it('issues one independent request per runtime and writes only its own registry', async () => {
  const loads: Deferred<number>[] = [];
  const definition = controlledDefinition(loads);
  const runtimeA = runtime();
  const runtimeB = runtime();
  const managerA = runtimeA.resources;
  const managerB = runtimeB.resources;
  const handleA = managerA.handle(definition);
  const handleB = managerB.handle(definition);
  expect(handleA.atom, 'Atom identity is per manager/registry').not.toBe(handleB.atom);

  const pendingA = managerA.ensure(handleA);
  const pendingB = managerB.ensure(handleB);
  await expect.poll(() => loads.length).toBe(2);
  expect(loads.length, 'each runtime performs its own network read').toBe(2);

  loads[1].resolve(22);
  await pendingB;
  expect(managerB.state(handleB)._tag).toBe('Success');
  expect(managerB.value(handleB)).toBe(22);
  expect(managerA.value(handleA), 'runtime B must not write runtime A').toBeUndefined();

  loads[0].resolve(11);
  await pendingA;
  expect(managerA.value(handleA)).toBe(11);
});

it('cancel/dispose of one runtime never cancels or mutates the other', async () => {
  const loads: Deferred<number>[] = [];
  const definition = controlledDefinition(loads);
  const runtimeA = runtime();
  const runtimeB = runtime();
  const managerA = runtimeA.resources;
  const managerB = runtimeB.resources;
  const handleA = managerA.handle(definition);
  const handleB = managerB.handle(definition);

  const pendingA = managerA.ensure(handleA);
  const pendingB = managerB.ensure(handleB);
  await expect.poll(() => loads.length).toBe(2);

  await runtimeA.dispose();
  await expect(pendingA).rejects.toBeDefined();
  loads[1].resolve(44);
  await pendingB;
  expect(managerB.value(handleB)).toBe(44);
  expect(managerB.state(handleB)._tag).toBe('Success');
});