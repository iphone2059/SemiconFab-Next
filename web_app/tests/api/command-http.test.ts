import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { createHttpCommandGateway } from '@/api/http-command-gateway';
import { submitEquipmentCommand } from '@/api/commands.mutation';

/** HTTP command submission and authoritative recovery responses are API-owned. */

const runPromise = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const statusBody = {
  siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-1', action: 'START',
  commandId: 'cmd-1', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z',
};

const recoveryListBody = {
  epoch: 'epoch-1',
  latestSequence: 7,
  commands: [{
    siteId: 'site-1', fabId: 'fab-a', commandId: 'cmd-1', revision: 2,
    outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z', terminal: true,
  }],
};

const journalPageBody = {
  epoch: 'epoch-1',
  hasGap: false,
  firstRetainedSequence: 0,
  latestSequence: 7,
  events: [{
    sequence: 3, fabId: 'fab-a', commandId: 'cmd-1', revision: 2,
    outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z',
  }],
};

it('queries authoritative command status and models 404 as null', async () => {
  const gateway = createHttpCommandGateway({
    runPromise,
    fetchImpl: async (input) => String(input).includes('missing')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(statusBody), { status: 200 }),
  });
  await expect(gateway.getCommandStatus('fab-a', 'cmd-1')).resolves.toMatchObject({ revision: 2, outcome: 'succeeded' });
  await expect(gateway.getCommandStatus('fab-a', 'missing')).resolves.toBeNull();
});

it('rejects authoritative status for the wrong command, FAB or malformed revision', async () => {
  const value = { ...statusBody, commandId: 'wrong', revision: 1, outcome: 'executing' };
  const gateway = createHttpCommandGateway({ runPromise, fetchImpl: async () => new Response(JSON.stringify(value), { status: 200 }) });
  await expect(gateway.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow(/identity mismatch/);
  const crossed = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response(JSON.stringify({ ...value, fabId: 'fab-b', commandId: 'cmd-1' }), { status: 200 }),
  });
  await expect(crossed.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow(/identity mismatch/);
  const malformed = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response(JSON.stringify({ ...value, commandId: 'cmd-1', revision: 'NaN' }), { status: 200 }),
  });
  await expect(malformed.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow();
});

it('uses the single browser HTTP policy for authoritative command queries', async () => {
  let seen: RequestInit | undefined;
  const gateway = createHttpCommandGateway({
    runPromise,
    fetchImpl: async (_target, init) => {
      seen = init;
      return new Response('', { status: 404 });
    },
  });
  await expect(gateway.getCommandStatus('fab-a', 'missing')).resolves.toBeNull();
  expect(seen).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
});

it('decodes the authoritative FAB command list and rejects foreign FAB records', async () => {
  const urls: string[] = [];
  const gateway = createHttpCommandGateway({
    runPromise,
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(recoveryListBody), { status: 200 });
    },
  });
  await expect(gateway.listFabCommands('site-1', 'fab-a', 'active')).resolves.toMatchObject({
    epoch: 'epoch-1',
    latestSequence: 7,
    commands: [{ commandId: 'cmd-1', revision: 2, terminal: true }],
  });
  expect(urls[0]).toBe('/api/v1/sites/site-1/fabs/fab-a/commands?status=active');

  const crossed = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response(JSON.stringify({
      ...recoveryListBody,
      commands: [{ ...recoveryListBody.commands[0], fabId: 'fab-b' }],
    }), { status: 200 }),
  });
  await expect(crossed.listFabCommands('site-1', 'fab-a', 'all')).rejects.toThrow(/identity mismatch/);
});

it('decodes the journal page from an explicit cursor and maps hasGap through', async () => {
  const urls: string[] = [];
  const gateway = createHttpCommandGateway({
    runPromise,
    fetchImpl: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(journalPageBody), { status: 200 });
    },
  });
  await expect(gateway.getCommandJournalPage('site-1', 'fab-a', { afterSequence: 2, limit: 50 }))
    .resolves.toMatchObject({ hasGap: false, latestSequence: 7, events: [{ sequence: 3, revision: 2 }] });
  expect(urls[0]).toBe('/api/v1/sites/site-1/fabs/fab-a/command-journal?afterSequence=2&limit=50');
});

it('rejects unknown FAB (404), store failure (503) and malformed recovery payloads', async () => {
  const notFound = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  await expect(notFound.listFabCommands('site-1', 'unknown-fab', 'active')).rejects.toMatchObject({ _tag: 'HttpFailure', status: 404 });
  const unavailable = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response('COMMAND_STORE_UNAVAILABLE', { status: 503 }),
  });
  await expect(unavailable.getCommandJournalPage('site-1', 'fab-a', { afterSequence: 0 }))
    .rejects.toMatchObject({ _tag: 'HttpFailure', status: 503 });
  const malformed = createHttpCommandGateway({
    runPromise,
    fetchImpl: async () => new Response(JSON.stringify({ epoch: 'epoch-1', latestSequence: -1, commands: [] }), { status: 200 }),
  });
  await expect(malformed.listFabCommands('site-1', 'fab-a', 'all')).rejects.toMatchObject({ _tag: 'InvalidServerResponse' });
});

it('submits equipment commands over HTTP', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    commandId: '11111111-1111-4111-8111-111111111111', siteId: 'site-1', fabId: 'fab-a',
    equipmentId: 'equipment-0', action: 'START', revision: 0, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z',
  }), { status: 202 }));
  await expect(Effect.runPromise(submitEquipmentCommand(
    { siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-0', action: 'START', idempotencyKey: 'idem-1' },
    fetchImpl,
  ))).resolves.toMatchObject({ commandId: '11111111-1111-4111-8111-111111111111', outcome: 'accepted' });
  expect(fetchImpl).toHaveBeenCalledWith('/api/v1/sites/site-1/commands', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'Idempotency-Key': 'idem-1' }),
  }));
});
