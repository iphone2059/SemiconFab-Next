import { expect, it, vi } from 'vitest';
import { createHttpCommandGateway } from '../../src/api/transport/HttpCommandGateway';
import { submitEquipmentCommand } from '../../src/api/mutations/commands.mutations';

/** HTTP command submission and authoritative status response are API-owned. */

it('queries authoritative command status and maps 404 to null', async () => {
  const gateway = createHttpCommandGateway({
    fetchImpl: async (input) => String(input).includes('missing')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-1', action: 'START', commandId: 'cmd-1', revision: 2, outcome: 'succeeded', occurredAt: '2026-10-27T00:00:00Z' }), { status: 200 }),
  });
  await expect(gateway.getCommandStatus('fab-a', 'cmd-1')).resolves.toMatchObject({ revision: 2, outcome: 'succeeded' });
  await expect(gateway.getCommandStatus('fab-a', 'missing')).resolves.toBeNull();
});


it('rejects authoritative status for the wrong command, FAB or malformed revision', async () => {
  const value = { siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-1', action: 'START',
    commandId: 'wrong', revision: 1, outcome: 'executing', occurredAt: '2026-10-27T00:00:00Z' };
  const gateway = createHttpCommandGateway({ fetchImpl: async () =>
    new Response(JSON.stringify(value), { status: 200 }) });
  await expect(gateway.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow(/identity mismatch/);
  const crossed = createHttpCommandGateway({ fetchImpl: async () =>
    new Response(JSON.stringify({ ...value, fabId: 'fab-b', commandId: 'cmd-1' }), { status: 200 }) });
  await expect(crossed.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow(/identity mismatch/);
  const malformed = createHttpCommandGateway({ fetchImpl: async () =>
    new Response(JSON.stringify({ ...value, commandId: 'cmd-1', revision: 'NaN' }), { status: 200 }) });
  await expect(malformed.getCommandStatus('fab-a', 'cmd-1')).rejects.toThrow();
});


it('uses the single browser HTTP policy for authoritative command queries', async () => {
  let seen: RequestInit | undefined;
  const gateway = createHttpCommandGateway({ fetchImpl: async (_target, init) => {
    seen = init;
    return new Response('', { status: 404 });
  } });
  await expect(gateway.getCommandStatus('fab-a', 'missing')).resolves.toBeNull();
  expect(seen).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
});


it('submits equipment commands over HTTP', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    commandId: '11111111-1111-4111-8111-111111111111', siteId: 'site-1', fabId: 'fab-a',
    equipmentId: 'equipment-0', action: 'START', revision: 0, outcome: 'accepted', occurredAt: '2026-10-27T00:00:00Z',
  }), { status: 202 }));
  await expect(submitEquipmentCommand(
    { siteId: 'site-1', fabId: 'fab-a', equipmentId: 'equipment-0', action: 'START', idempotencyKey: 'idem-1' },
    fetchImpl,
  )).resolves.toMatchObject({ commandId: '11111111-1111-4111-8111-111111111111', outcome: 'accepted' });
  expect(fetchImpl).toHaveBeenCalledWith('/api/v1/sites/site-1/commands', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'Idempotency-Key': 'idem-1' }),
  }));
});

