import { Effect, Option } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource, ResourceDefinitionConflictError, ResourceReadTimeoutError, type ResourceCommitContext } from '@/api/resource';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
import { httpTransport } from '@/api/http.transport';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../../support/resource-test-runtime.tsx';

const runtimes: AppRuntime<never>[] = [];
const runtime = () => {
  const value = createTestRuntime();
  runtimes.push(value);
  return value;
};
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const deferred = <A,>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>(res => { resolve = res; });
  return { promise, resolve };
};
const frame = (sequence: number, epoch = 1): EquipmentStatusSnapshot => ({
  siteId: 'site-1', fabId: 'fab-1', epoch, sequence,
  generatedAt: '2026-10-30T00:00:00Z',
  tools: FAB_LAYOUT.map(() => ({ state: 'running' })),
});
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

it.each([10, 9])('completes waiting on an ignored equipment GET sequence %s without replacing payload/time', async sequence => {
  const manager = runtime().resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  const accepted = frame(10);
  manager.publish(handle, accepted);
  const before = manager.state(handle);
  expect(AsyncResult.isSuccess(before)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => response(frame(sequence))));
  const read = manager.refresh(handle);
  expect(manager.state(handle).waiting).toBe(true);
  await read;
  const after = manager.state(handle);
  expect(after.waiting).toBe(false);
  expect(manager.value(handle)).toBe(accepted);
  if (AsyncResult.isSuccess(before) && AsyncResult.isSuccess(after)) expect(after.timestamp).toBe(before.timestamp);
  expect(manager.stats.inFlight).toBe(0);
});

it('recovers an old error only on a valid equal-generation GET, never invalid/stale candidates', async () => {
  const manager = runtime().resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  const accepted = frame(10);
  manager.publish(handle, accepted);
  const before = manager.state(handle);
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  await expect(manager.refresh(handle)).rejects.toThrow('offline');
  const failure = manager.state(handle);
  expect(AsyncResult.isFailure(failure)).toBe(true);
  fetchMock.mockResolvedValueOnce(response(frame(9)));
  await manager.refresh(handle);
  expect(manager.state(handle)).toBe(failure);
  fetchMock.mockResolvedValueOnce(response({ ...frame(10), tools: FAB_LAYOUT.map(() => ({ state: 'maint' })) }));
  await manager.refresh(handle);
  expect(manager.state(handle), 'equal counters with conflicting tools cannot confirm recovery').toBe(failure);
  fetchMock.mockResolvedValueOnce(response({ ...frame(10), generatedAt: '2026-10-30T00:00:01Z' }));
  await manager.refresh(handle);
  expect(manager.state(handle), 'equal counters with a conflicting timestamp are also not unchanged').toBe(failure);
  fetchMock.mockResolvedValueOnce(response({ ...frame(10), tools: [] }));
  await expect(manager.refresh(handle)).rejects.toThrow();
  expect(AsyncResult.isFailure(manager.state(handle))).toBe(true);
  fetchMock.mockResolvedValueOnce(response(frame(10)));
  await manager.refresh(handle);
  const restored = manager.state(handle);
  expect(AsyncResult.isSuccess(restored)).toBe(true);
  expect(restored.waiting).toBe(false);
  expect(manager.value(handle)).toBe(accepted);
  if (AsyncResult.isSuccess(before) && AsyncResult.isSuccess(restored)) expect(restored.timestamp).toBe(before.timestamp);
});

it('clears only current waiting after an out-of-order read, never rolls back a newer push', async () => {
  const manager = runtime().resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  manager.publish(handle, frame(10));
  const gate = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => gate.promise));
  const read = manager.refresh(handle);
  const pushed = frame(12);
  manager.publish(handle, pushed);
  const state = manager.state(handle);
  gate.resolve(response(frame(11)));
  await read;
  expect(manager.state(handle)).toBe(state);
  expect(manager.value(handle)).toBe(pushed);
});

it('Ignore completion preserves writeSeq and request baseline (control state is not publication)', async () => {
  const manager = runtime().resources;
  const contexts: Array<{ baselineWriteSeq: number; writeSeq: number }> = [];
  const definition = defineResource({
    identity: { kind: 'ignore-control', version: 1, key: 'ignore-control' },
    load: Effect.succeed('candidate'),
    policy: { freshnessMs: 0, idleTtlMs: 300_000 },
    accept: (_next: string, context: ResourceCommitContext<string>) => {
      contexts.push(context);
      return context.origin === 'read'
        ? { _tag: 'Ignore' as const, reason: 'rejected' as const }
        : { _tag: 'Publish' as const, value: _next };
    },
  });
  const handle = manager.handle(definition);
  manager.publish(handle, 'original');
  await manager.refresh(handle);
  await manager.refresh(handle);
  expect(contexts.slice(1).map(ctx => [ctx.baselineWriteSeq, ctx.writeSeq])).toEqual([[1, 1], [1, 1]]);
  expect(manager.value(handle)).toBe('original');
  expect(manager.state(handle).waiting).toBe(false);
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid read deadline %s at admission', timeout => {
  const manager = runtime().resources;
  expect(() => manager.handle(hangingDefinition(timeout))).toThrow(RangeError);
  expect(manager.stats.entries).toBe(0);
});

it('treats effective deadline as part of same-key policy compatibility', () => {
  const manager = runtime().resources;
  const definition = hangingDefinition(30_000);
  const explicit = manager.handle(definition);
  expect(manager.handle({ ...definition, policy: { freshnessMs: 0, idleTtlMs: 1_000 } })).toBe(explicit);
  expect(() => manager.handle(hangingDefinition(200))).toThrow(ResourceDefinitionConflictError);
});

const hangingDefinition = (loadTimeoutMs = 100, idleTtlMs = 1_000) => defineResource({
  identity: { kind: 'hanging-read', version: 1, key: 'hanging-read' },
  load: httpTransport.fetchJson('/api/hanging'),
  policy: { freshnessMs: 0, idleTtlMs, loadTimeoutMs },
});

it.each(['fetch', 'body'] as const)('deadline interrupts hung %s, fails with retained value and frees single-flight', async phase => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const handle = manager.handle(hangingDefinition());
  manager.publish(handle, 'retained');
  let signal!: AbortSignal;
  const hung = deferred<Response>();
  const body = deferred<string>();
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init!.signal!;
    return phase === 'fetch' ? hung.promise : Promise.resolve({ ok: true, text: () => body.promise } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  const release = manager.retain(handle);
  const read = manager.refresh(handle);
  const outcome = read.catch(error => error);
  expect(manager.refresh(handle)).toBe(read);
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(101);
  expect(signal.aborted).toBe(true);
  const error = await outcome;
  expect(error).toBeInstanceOf(ResourceReadTimeoutError);
  if (!(error instanceof ResourceReadTimeoutError)) throw new Error('Expected read timeout');
  expect(error.name).toBe('ResourceReadTimeoutError');
  expect(error.timeoutMs).toBe(100);
  expect(manager.stats.inFlight).toBe(0);
  expect(AsyncResult.isFailure(manager.state(handle))).toBe(true);
  expect(Option.getOrUndefined(AsyncResult.error(manager.state(handle)))).toBe(error);
  expect(manager.value(handle)).toBe('retained');
  fetchMock.mockImplementationOnce(async () => response('new'));
  const next = manager.refresh(handle);
  await vi.advanceTimersByTimeAsync(0);
  await expect(next).resolves.toBe('new');
  hung.resolve(response('late'));
  body.resolve(JSON.stringify('late'));
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.value(handle)).toBe('new');
  release();
});

it('a timed-out read after an accepted push cannot overwrite the newer success', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const handle = manager.handle(hangingDefinition());
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  const outcome = manager.refresh(handle).catch(error => error);
  manager.publish(handle, 'newer-push');
  const pushed = manager.state(handle);
  await vi.advanceTimersByTimeAsync(101);
  expect(await outcome).toBeInstanceOf(ResourceReadTimeoutError);
  expect(manager.state(handle)).toBe(pushed);
  expect(manager.diagnostics.at(-1)?.reason).toBe('superseded-write');
  expect(manager.stats.inFlight).toBe(0);
});

it('unretained prefetch is canceled at the fixed idle TTL even before its deadline', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const handle = manager.handle(hangingDefinition(1_000, 20));
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init!.signal!;
    return new Promise<Response>(() => undefined);
  }));
  const outcome = manager.ensure(handle).catch(error => error);
  await vi.advanceTimersByTimeAsync(21);
  expect(signal.aborted).toBe(true);
  expect(manager.stats.entries).toBe(0);
  expect(manager.stats.inFlight).toBe(0);
  expect(await outcome).toBeInstanceOf(Error);
});

it('unretained loader ensure has a finite default deadline and releases its flight', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const handle = manager.handle(defineResource({
    identity: { kind: 'loader', version: 1, key: 'loader' },
    load: httpTransport.fetchJson('/api/loader'),
    policy: { freshnessMs: 0, idleTtlMs: 300_000 },
  }));
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init!.signal!;
    return new Promise<Response>(() => undefined);
  }));
  const outcome = manager.ensure(handle).catch(error => error);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(await outcome).toBeInstanceOf(ResourceReadTimeoutError);
  expect(signal.aborted).toBe(true);
  expect(manager.stats.inFlight).toBe(0);
});

it('last release keeps a bounded shared GET for StrictMode remount and loader waiters', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const handle = manager.handle(hangingDefinition());
  const gate = deferred<Response>();
  let signal!: AbortSignal;
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init!.signal!;
    return gate.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  const loader = manager.ensure(handle);
  const release = manager.retain(handle);
  await vi.advanceTimersByTimeAsync(0);
  release();
  const releaseAgain = manager.retain(handle);
  expect(manager.ensure(handle)).toBe(loader);
  expect(signal.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  gate.resolve(response('shared'));
  await vi.advanceTimersByTimeAsync(0);
  await expect(loader).resolves.toBe('shared');
  releaseAgain();
});

it('idle TTL never renews for a hanging read; canceled late completion cannot pollute recreated identity', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const definition = hangingDefinition(1_000, 20);
  const handle = manager.handle(definition);
  const gate = deferred<Response>();
  let signal!: AbortSignal;
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
    signal = init!.signal!;
    return gate.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  const release = manager.retain(handle);
  const outcome = manager.ensure(handle).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  release();
  await vi.advanceTimersByTimeAsync(21);
  expect(manager.stats.entries).toBe(0);
  expect(manager.stats.inFlight).toBe(0);
  expect(signal.aborted).toBe(true);
  await outcome;
  const recreated = manager.handle(definition);
  expect(recreated).not.toBe(handle);
  manager.publish(recreated, 'new-generation');
  gate.resolve(response('late-old-generation'));
  await vi.advanceTimersByTimeAsync(0);
  expect(manager.value(recreated)).toBe('new-generation');
});
