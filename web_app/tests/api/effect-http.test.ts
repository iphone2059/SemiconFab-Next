import { Effect, Exit, Cause } from 'effect';
import { expect, it } from 'vitest';
import { createHttpTransport } from '@/api/http.transport';
import { submitEquipmentCommand } from '@/api/commands.mutation';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import { fetchWaferRoutes } from '@/api/wafer.resource';
import { vi } from 'vitest';

// Dropping the Effect cancellation signal would leave the underlying request alive.
it('interrupting a request aborts the real injected fetch', async () => {
  let aborted = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transport = createHttpTransport({ fetchImpl: (_path, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    started();
  }) });
  const controller = new AbortController();
  const request = transport.fetchJson('/api/v1/sites');
  if (!Effect.isEffect(request)) { controller.abort(); }
  expect(Effect.isEffect(request)).toBe(true);
  const pending = Effect.runPromiseExit(request, { signal: controller.signal });
  await ready;
  controller.abort();
  const exit = await pending;
  expect(aborted).toBe(true);
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
});

// Collapsing parse/network/status failures into a generic Error loses retry decisions.
it.each([
  ['network', async () => { throw new TypeError('offline'); }, 'NetworkUnavailable'],
  ['status', async () => new Response('{"detail":"denied"}', { status: 401 }), 'HttpFailure'],
  ['non-json', async () => new Response('gateway'), 'InvalidServerResponse'],
] as const)('classifies %s failures in the typed channel', async (_name, fetchImpl, tag) => {
  const request = createHttpTransport({ fetchImpl }).fetchJson('/api/v1/sites');
  if (!Effect.isEffect(request)) await Promise.resolve(request).catch(() => undefined);
  expect(Effect.isEffect(request)).toBe(true);
  const result = await Effect.runPromise(Effect.result(request));
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: tag } });
});

// Completing response headers must not detach cancellation while its body is pending.
it('interruption aborts fetch while reading a pending response body', async () => {
  let aborted = false;
  let bodyStarted!: () => void;
  const ready = new Promise<void>(resolve => { bodyStarted = resolve; });
  const transport = createHttpTransport({ fetchImpl: async (_path, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
      pull() { bodyStarted(); },
    });
    return new Response(stream);
  } });
  const controller = new AbortController();
  const pending = Effect.runPromiseExit(transport.fetchText('/api/v1/sites'), { signal: controller.signal });
  await ready;
  // Let fetch headers resolve before interrupting body consumption.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  controller.abort();
  const exit = await pending;
  expect(aborted).toBe(true);
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
});

const input = { siteId: 'site', fabId: 'fab', equipmentId: 'tool', action: 'START', idempotencyKey: 'stable' };
const accepted = { commandId: 'cmd', siteId: 'site', fabId: 'fab', equipmentId: 'tool', action: 'START',
  revision: 0, outcome: 'accepted', occurredAt: '2026-10-29T00:00:00Z' };
it.each([
  [{ ...accepted, revision: 'wrong' }, 202, 'InvalidServerResponse'],
  [{ ...accepted, fabId: 'another-fab' }, 202, 'CommandIdentityMismatch'],
  [{ detail: 'key conflict' }, 409, 'IdempotencyConflict'],
] as const)('keeps command response classification as %s %s %s', async (body, status, tag) => {
  const result = await Effect.runPromise(Effect.result(submitEquipmentCommand(input,
    async () => new Response(JSON.stringify(body), { status }))));
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: tag } });
});
it('models a missing command as null without swallowing a network failure', async () => {
  const missing = createHttpCommandGateway({ fetchImpl: async () => new Response('', { status: 404 }) });
  await expect(Effect.runPromise(missing.getCommandStatus('fab', 'cmd'))).resolves.toBeNull();
  const offline = createHttpCommandGateway({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await expect(Effect.runPromise(Effect.flip(offline.getCommandStatus('fab', 'cmd'))))
    .resolves.toMatchObject({ _tag: 'CommandGatewayRetryableFailure' });
});
// An invalid static document is a validation failure rather than an Effect defect.
it('reports malformed wafer-route data through the expected API error channel', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}'));
  try {
    const result = await Effect.runPromise(Effect.result(fetchWaferRoutes()));
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidServerResponse' } });
  } finally { vi.unstubAllGlobals(); }
});
