/**
 * F4 / matrix-4 — native-Effect authoritative gateway (ADR-011 §2.1).
 *
 * Every method returns a cancellable Effect; interruption propagates to the real
 * fetch AbortSignal; journal cursors are epoch-scoped; HTTP 409
 * journal-epoch-mismatch becomes CommandJournalEpochMismatch so recovery can fall
 * back to the authoritative list.
 */
import { Duration, Effect, Option } from 'effect';
import { expect, it } from 'vitest';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import type { CommandJournalPage } from '@/contracts/command-gateway.contract';

const statusBody = {
  siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-1', action: 'START',
  commandId: 'cmd-1', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z',
};

const journalPageBody = {
  epoch: 'epoch-1',
  hasGap: false,
  firstRetainedSequence: 0,
  latestSequence: 7,
  nextAfterSequence: 3,
  events: [{
    sequence: 3, fabId: 'fab-a', commandId: 'cmd-1', revision: 2,
    outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z',
  }],
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

it('queries authoritative status and models 404 as null through the native Effect channel', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async (input) => String(input).includes('missing') ? new Response('', { status: 404 }) : json(statusBody),
  });
  const status = gateway.getCommandStatus('fab-a', 'cmd-1');
  expect(Effect.isEffect(status)).toBe(true);
  await expect(Effect.runPromise(status)).resolves.toMatchObject({ revision: 2, outcome: 'succeeded' });
  await expect(Effect.runPromise(gateway.getCommandStatus('fab-a', 'missing'))).resolves.toBeNull();
});

it('sends the frozen epoch-scoped journal cursor and returns nextAfterSequence', async () => {
  const urls: string[] = [];
  const gateway = createHttpCommandGateway({
    fetchImpl: async (input) => {
      urls.push(String(input));
      return json(journalPageBody);
    },
  });
  const page: CommandJournalPage = await Effect.runPromise(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 2, limit: 50 }),
  );
  expect(urls[0]).toBe('/api/v1/sites/site-1/fabs/fab-a/command-journal?epoch=epoch-1&afterSequence=2&limit=50');
  expect(page).toMatchObject({ epoch: 'epoch-1', latestSequence: 7, nextAfterSequence: 3 });
});

it('maps 400 journal-cursor-invalid to a terminal invalid-request (never retried by sequence)', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => json({ code: 'journal-cursor-invalid', title: 'journal cursor is invalid' }, 400),
  });
  const error = await Effect.runPromise(Effect.flip(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'stale-epoch', afterSequence: 2 }),
  ));
  expect(error).toMatchObject({ _tag: 'CommandGatewayTerminalFailure', reason: 'invalid-request', status: 400 });
});

it('passes through the authoritative nextAfterSequence of an empty FAB-filtered page (loop termination input)', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => json({
      epoch: 'epoch-1', hasGap: false, firstRetainedSequence: 0, latestSequence: 42, nextAfterSequence: 42, events: [],
    }),
  });
  const page = await Effect.runPromise(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 42 }),
  );
  expect(page).toMatchObject({ events: [], nextAfterSequence: 42, latestSequence: 42 });
});

it('keeps the POST idempotency-conflict 409 shape out of the journal epoch branch (no silent fallback)', async () => {
  // F3 backend: POST /commands idempotency conflicts are 409
  // {title,status,detail?,errorCode:'IDEMPOTENCY_CONFLICT'} (no 'code'/epoch fields).
  // Only journal epoch mismatch may fall back to the authoritative list.
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => json({
      title: 'idempotency key conflict',
      status: 409,
      detail: null,
      errorCode: 'IDEMPOTENCY_CONFLICT',
    }, 409),
  });
  const error = await Effect.runPromise(Effect.flip(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 2 }),
  ));
  expect(error).toMatchObject({ _tag: 'CommandGatewayTerminalFailure', reason: 'rejected', status: 409 });
});

it('maps journal 409 epoch mismatch to CommandJournalEpochMismatch with authoritative epoch fields', async () => {
  const gateway = createHttpCommandGateway({
    // Real F3 response is application/problem+json: standard ProblemDetails fields
    // and the epoch extensions all live at the top level of the same body.
    fetchImpl: async () => json({
      type: 'https://fab.local/problems/journal-epoch-mismatch',
      title: 'journal cursor belongs to a replaced epoch',
      status: 409,
      detail: 'the requested cursor epoch was replaced',
      instance: '/api/v1/sites/site-1/fabs/fab-a/command-journal',
      code: 'journal-epoch-mismatch',
      currentEpoch: 'epoch-2',
      firstRetainedSequence: 5,
      latestSequence: 9,
    }, 409),
  });
  const error = await Effect.runPromise(Effect.flip(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 2 }),
  ));
  expect(error).toMatchObject({
    _tag: 'CommandJournalEpochMismatch',
    currentEpoch: 'epoch-2',
    firstRetainedSequence: 5,
    latestSequence: 9,
  });
});

it('decodes the journal 409 when detail/instance are null (ASP.NET ProblemDetails serialization variance)', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => json({
      type: 'https://fab.local/problems/journal-epoch-mismatch',
      title: 'journal cursor belongs to a replaced epoch',
      status: 409,
      detail: null,
      instance: null,
      code: 'journal-epoch-mismatch',
      currentEpoch: 'epoch-2',
      firstRetainedSequence: 5,
      latestSequence: 9,
    }, 409),
  });
  const error = await Effect.runPromise(Effect.flip(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 2 }),
  ));
  expect(error).toMatchObject({ _tag: 'CommandJournalEpochMismatch', currentEpoch: 'epoch-2' });
});

it('decodes the journal 409 when standard ProblemDetails fields are omitted entirely', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => json({
      code: 'journal-epoch-mismatch',
      currentEpoch: 'epoch-2',
      firstRetainedSequence: 5,
      latestSequence: 9,
    }, 409),
  });
  const error = await Effect.runPromise(Effect.flip(
    gateway.getCommandJournalPage('site-1', 'fab-a', { epoch: 'epoch-1', afterSequence: 2 }),
  ));
  expect(error).toMatchObject({ _tag: 'CommandJournalEpochMismatch', currentEpoch: 'epoch-2', firstRetainedSequence: 5, latestSequence: 9 });
});

it.each([
  [500, 'CommandGatewayRetryableFailure', undefined],
  [503, 'CommandGatewayRetryableFailure', undefined],
  [429, 'CommandGatewayRetryableFailure', undefined],
  [400, 'CommandGatewayTerminalFailure', 'invalid-request'],
  [404, 'CommandGatewayTerminalFailure', 'rejected'],
] as const)('classifies HTTP %i as %s / %s', async (status, tag, reason) => {
  const gateway = createHttpCommandGateway({ fetchImpl: async () => json({ title: 'failed' }, status) });
  const error = await Effect.runPromise(Effect.flip(gateway.listFabCommands('site-1', 'fab-a', 'active')));
  expect(error._tag).toBe(tag);
  if (reason !== undefined && error._tag === 'CommandGatewayTerminalFailure') expect(error.reason).toBe(reason);
});

it('classifies network failures as retryable and malformed/foreign payloads as terminal', async () => {
  const offline = createHttpCommandGateway({ fetchImpl: async () => { throw new TypeError('offline'); } });
  const networkError = await Effect.runPromise(Effect.flip(offline.getCommandStatus('fab-a', 'cmd-1')));
  expect(networkError).toMatchObject({ _tag: 'CommandGatewayRetryableFailure' });

  const malformed = createHttpCommandGateway({
    fetchImpl: async () => json({ epoch: 'epoch-1', latestSequence: -1, commands: [] }),
  });
  const invalid = await Effect.runPromise(Effect.flip(malformed.listFabCommands('site-1', 'fab-a', 'all')));
  expect(invalid).toMatchObject({ _tag: 'CommandGatewayTerminalFailure', reason: 'invalid-response' });

  const foreign = createHttpCommandGateway({
    fetchImpl: async () => json({
      epoch: 'epoch-1', latestSequence: 1,
      commands: [{ siteId: 'site-1', fabId: 'fab-b', commandId: 'cmd-1', revision: 1, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z', terminal: true }],
    }),
  });
  const identity = await Effect.runPromise(Effect.flip(foreign.listFabCommands('site-1', 'fab-a', 'active')));
  expect(identity).toMatchObject({ _tag: 'CommandGatewayTerminalFailure', reason: 'identity-mismatch' });
});

it('maps a spontaneous AbortError rejection to CommandRequestAborted (cancellation, not failure)', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async () => { throw new DOMException('The operation was aborted.', 'AbortError'); },
  });
  const error = await Effect.runPromise(Effect.flip(gateway.getCommandStatus('fab-a', 'cmd-1')));
  expect(error).toMatchObject({ _tag: 'CommandRequestAborted' });
});

it('interruption propagates to the real fetch AbortSignal (timeoutOption cancels a hung request)', async () => {
  let aborted = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gateway = createHttpCommandGateway({
    fetchImpl: (_path, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
      started();
    }),
  });
  const result = await Effect.runPromise(
    Effect.timeoutOption(gateway.getCommandStatus('fab-a', 'cmd-1'), Duration.millis(25)),
  );
  await ready;
  expect(Option.isNone(result), 'the hung request must be interrupted by the timeout').toBe(true);
  expect(aborted, 'the interruption must reach the real fetch AbortSignal').toBe(true);
});
