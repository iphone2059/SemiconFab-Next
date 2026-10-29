import { expect, it, vi } from 'vitest';
import { submitEquipmentCommand } from '@/api/commands.mutation';
import type { CommandOutcome } from '@/contracts/command-events.contract';
import {
  MAX_ACTION_LENGTH,
  MAX_EQUIPMENT_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  commandIdentityMismatches,
  createEquipmentCommandIdempotencyKey,
  submitEquipmentCommandInputSchema,
  submittedEquipmentCommandSchema,
  type SubmitEquipmentCommandInput,
} from '@/api/command.schema';

/**
 * R-03 boundary contract for `POST /api/v1/sites/{siteId:guid}/commands`.
 *
 * Verified against the authoritative backend (fab_app/src/ApiHost.cs,
 * fab_app/src/EquipmentCommandService.cs): a successful submission is 202 Accepted
 * with an EquipmentCommandStatus where SiteId/FabId/CommandId are Guid.ToString("D"),
 * Revision is an int (0 accepted / 1 executing / 2 succeeded), Outcome is a
 * command-protocol outcome and OccurredAt is DateTimeOffset.ToString("O") — a
 * round-trip ISO-8601 timestamp that always carries an offset. Failures are
 * ProblemDetails (400/404/409) or a non-JSON gateway/proxy body. The real service
 * echoes equipmentId/action verbatim and canonicalizes Guid request identities.
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_FAB_ID = '2d3f8c1a-9b4e-4f6d-8a1c-5e7d9b0a2c3d';

const request = (overrides: Partial<SubmitEquipmentCommandInput> = {}): SubmitEquipmentCommandInput => ({
  siteId: SITE_ID,
  fabId: FAB_ID,
  equipmentId: 'equipment-0',
  action: 'START',
  idempotencyKey: 'idem-1',
  ...overrides,
});

const acceptedBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  commandId: COMMAND_ID,
  siteId: SITE_ID,
  fabId: FAB_ID,
  equipmentId: 'equipment-0',
  action: 'START',
  revision: 0,
  outcome: 'accepted',
  occurredAt: '2026-10-27T00:00:00.0000000+00:00',
  ...overrides,
});

const without = (field: string): Record<string, unknown> => {
  const body = acceptedBody();
  delete body[field];
  return body;
};

const respond = (body: unknown, status = 202) =>
  vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));

const respondRaw = (raw: string, status = 202, contentType = 'application/json') =>
  vi.fn(async () => new Response(raw, { status, headers: { 'content-type': contentType } }));

const submit = (body: unknown, status = 202) => submitEquipmentCommand(request(), respond(body, status));

it('posts the JSON command to the site endpoint with an idempotency key', async () => {
  const fetchImpl = respond(acceptedBody());
  const result = await submitEquipmentCommand(request(), fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith('/api/v1/sites/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands', expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    body: JSON.stringify({ fabId: FAB_ID, equipmentId: 'equipment-0', action: 'START' }),
  }));
  expect(result).toEqual(acceptedBody());
});

it('rejects a 202 body with a missing field instead of inventing a value', async () => {
  for (const field of ['commandId', 'siteId', 'fabId', 'equipmentId', 'action', 'revision', 'outcome', 'occurredAt']) {
    await expect(submit(without(field)), field).rejects.toThrow(/invalid command response|格式无效/);
  }
});

it('rejects wrong server types instead of coercing them', async () => {
  const cases: Record<string, unknown>[] = [
    { revision: '0' },
    { revision: null },
    { revision: true },
    { commandId: 111 },
    { siteId: ['site-1'] },
    { equipmentId: {} },
    { action: null },
    { outcome: 42 },
    { occurredAt: 1234567890 },
  ];
  for (const override of cases) {
    await expect(submit(acceptedBody(override)), JSON.stringify(override)).rejects.toThrow(/invalid command response|格式无效/);
  }
});

it('rejects a revision that is not a finite non-negative integer', async () => {
  for (const revision of [1.5, -1]) {
    await expect(submit(acceptedBody({ revision })), String(revision)).rejects.toThrow(/invalid command response|格式无效/);
  }
  // JSON cannot carry NaN/Infinity, but a gateway can still write the literal tokens.
  const rawBody = (revision: string) =>
    '{"commandId":"' + COMMAND_ID + '","siteId":"' + SITE_ID + '","fabId":"' + FAB_ID +
    '","equipmentId":"equipment-0","action":"START","revision":' + revision +
    ',"outcome":"accepted","occurredAt":"2026-10-27T00:00:00Z"}';
  await expect(submitEquipmentCommand(request(), respondRaw(rawBody('NaN')))).rejects.toThrow();
  await expect(submitEquipmentCommand(request(), respondRaw(rawBody('1e999')))).rejects.toThrow(/invalid command response|格式无效/);
});

it('rejects an outcome that is not part of the command protocol', async () => {
  for (const outcome of ['rejected', 'success', 'ACCEPTED', '', null]) {
    await expect(submit(acceptedBody({ outcome })), String(outcome)).rejects.toThrow(/invalid command response|格式无效/);
  }
});

it('accepts every authoritative protocol outcome, not only the dev service ones', async () => {
  for (const [outcome, revision] of [['accepted', 0], ['executing', 1], ['succeeded', 2], ['failed', 2], ['cancelled', 2]] as const) {
    await expect(submit(acceptedBody({ outcome, revision }))).resolves.toMatchObject({ outcome, revision });
  }
});

it('rejects empty identity and action strings', async () => {
  for (const field of ['commandId', 'siteId', 'fabId', 'equipmentId', 'action']) {
    await expect(submit(acceptedBody({ [field]: '' })), field).rejects.toThrow(/invalid command response|格式无效/);
  }
});

it('rejects a response for another site, FAB, equipment or action', async () => {
  const mismatches: Record<string, unknown>[] = [
    { siteId: OTHER_SITE_ID },
    { fabId: OTHER_FAB_ID },
    { equipmentId: 'equipment-7' },
    { action: 'STOP' },
  ];
  for (const override of mismatches) {
    await expect(submit(acceptedBody(override)), JSON.stringify(override)).rejects.toThrow(/identity mismatch|不一致/);
  }
});

it('accepts GUID normalization of the echoed site/FAB identity', async () => {
  const upper = request({
    siteId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    fabId: 'F47AC10B-58CC-4372-A567-0E02B2C3D479',
  });
  await expect(submitEquipmentCommand(upper, respond(acceptedBody()))).resolves.toMatchObject({ fabId: FAB_ID });
});

it('rejects an HTML page returned with HTTP 200', async () => {
  await expect(submitEquipmentCommand(request(), respondRaw(
    '<!doctype html><html><body>gateway login</body></html>', 200, 'text/html',
  ))).rejects.toThrow(/not JSON|非 JSON/);
});

it('rejects a non-JSON body returned with a success status', async () => {
  await expect(submitEquipmentCommand(request(), respondRaw('not json'))).rejects.toThrow(/not JSON|非 JSON/);
});

it('surfaces ProblemDetails details for a rejected submission', async () => {
  const conflict = respond({ title: 'Idempotency-Key conflicts with an earlier request', detail: 'the same key was used for STOP' }, 409);
  await expect(submitEquipmentCommand(request(), conflict)).rejects.toThrow(/409[\s\S]*same key was used for STOP/);
  const missing = respond({ title: 'FAB not found in Site' }, 404);
  await expect(submitEquipmentCommand(request(), missing)).rejects.toThrow(/404[\s\S]*FAB not found in Site/);
  const proxy = respondRaw('Bad gateway', 502, 'text/plain');
  await expect(submitEquipmentCommand(request(), proxy)).rejects.toThrow(/502[\s\S]*Bad gateway/);
});

it('propagates a network failure unchanged', async () => {
  const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch command endpoint'); });
  await expect(submitEquipmentCommand(request(), fetchImpl)).rejects.toThrow(/Failed to fetch command endpoint/);
});

it('ignores additive server fields instead of copying them into the DTO', async () => {
  const result = await submit(acceptedBody({ serverOnly: 'ignored' }));
  expect(result).not.toHaveProperty('serverOnly');
  expect(result).toEqual(acceptedBody());
});

it('validates the submission input independently of the response', async () => {
  expect(submitEquipmentCommandInputSchema.parse(request())).toEqual(request());
  for (const field of ['siteId', 'fabId', 'equipmentId', 'action', 'idempotencyKey']) {
    expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), [field]: '' }).success, field).toBe(false);
  }
  const withoutKey: Record<string, unknown> = { ...request() };
  delete withoutKey.idempotencyKey;
  expect(submitEquipmentCommandInputSchema.safeParse(withoutKey).success).toBe(false);
  const fetchImpl = respond(acceptedBody());
  await expect(submitEquipmentCommand({ ...request(), siteId: '' }, fetchImpl)).rejects.toBeInstanceOf(Error);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('enforces the backend id/action/idempotency-key limits', () => {
  const tooLong = (length: number) => 'x'.repeat(length);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), equipmentId: tooLong(MAX_EQUIPMENT_ID_LENGTH + 1) }).success).toBe(false);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), action: tooLong(MAX_ACTION_LENGTH + 1) }).success).toBe(false);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), idempotencyKey: tooLong(MAX_IDEMPOTENCY_KEY_LENGTH + 1) }).success).toBe(false);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), idempotencyKey: 'idem-\n1' }).success).toBe(false);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), equipmentId: tooLong(MAX_EQUIPMENT_ID_LENGTH) }).success).toBe(true);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), action: tooLong(MAX_ACTION_LENGTH) }).success).toBe(true);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), idempotencyKey: tooLong(MAX_IDEMPOTENCY_KEY_LENGTH) }).success).toBe(true);
});

it('mints distinct idempotency keys accepted by the input schema', () => {
  const first = createEquipmentCommandIdempotencyKey();
  const second = createEquipmentCommandIdempotencyKey();
  expect(first).not.toBe(second);
  expect(submitEquipmentCommandInputSchema.safeParse({ ...request(), idempotencyKey: first }).success).toBe(true);
});

it('strictly types the response outcome and revision', () => {
  const parsed = submittedEquipmentCommandSchema.parse(acceptedBody());
  const outcome: CommandOutcome = parsed.outcome;
  expect(outcome).toBe('accepted');
  expect(parsed.revision).toBe(0);
  for (const revision of [NaN, Infinity, -Infinity, 1.5, -1]) {
    expect(submittedEquipmentCommandSchema.safeParse(acceptedBody({ revision })).success, String(revision)).toBe(false);
  }
  for (const illegal of ['rejected', 'success', 'ACCEPTED', '']) {
    expect(submittedEquipmentCommandSchema.safeParse(acceptedBody({ outcome: illegal })).success, illegal).toBe(false);
  }
  for (const legal of ['accepted', 'executing', 'succeeded', 'failed', 'cancelled']) {
    expect(submittedEquipmentCommandSchema.safeParse(acceptedBody({ outcome: legal })).success, legal).toBe(true);
  }
});

it('requires an ISO-8601 timestamp with an explicit offset', () => {
  for (const occurredAt of ['2026-10-27T00:00:00.0000000+00:00', '2026-10-27T00:00:00Z', '2026-10-27T08:30:00.123+08:00']) {
    expect(submittedEquipmentCommandSchema.safeParse(acceptedBody({ occurredAt })).success, occurredAt).toBe(true);
  }
  for (const occurredAt of ['2026-10-27T00:00:00', '2026-10-27', 'not-a-date', '']) {
    expect(submittedEquipmentCommandSchema.safeParse(acceptedBody({ occurredAt })).success, occurredAt).toBe(false);
  }
});

it('binds response identity to the submitted context with documented GUID normalization', () => {
  const submitted = request();
  const response = submittedEquipmentCommandSchema.parse(acceptedBody());
  expect(commandIdentityMismatches(submitted, response)).toEqual([]);
  expect(commandIdentityMismatches({ ...submitted, fabId: FAB_ID.toUpperCase() }, response)).toEqual([]);
  expect(commandIdentityMismatches({ ...submitted, siteId: OTHER_SITE_ID }, response)).toEqual(['siteId']);
  expect(commandIdentityMismatches({ ...submitted, fabId: OTHER_FAB_ID }, response)).toEqual(['fabId']);
  expect(commandIdentityMismatches({ ...submitted, equipmentId: 'equipment-1' }, response)).toEqual(['equipmentId']);
  expect(commandIdentityMismatches({ ...submitted, action: 'STOP' }, response)).toEqual(['action']);
});
