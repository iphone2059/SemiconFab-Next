/**
 * Runtime contract for the equipment-command HTTP endpoint (R-03).
 *
 * Verified against the authoritative backend sources:
 *  - fab_app/src/ApiHost.cs maps POST /api/v1/sites/{siteId:guid}/commands and returns
 *    202 Accepted with an EquipmentCommandStatus on success; failures are
 *    ProblemDetails 400/404/409 (invalid command, unknown site/FAB, idempotency
 *    conflict) or a non-JSON proxy/gateway body.
 *  - fab_app/src/EquipmentCommandService.cs defines the status record and its values:
 *    SiteId/FabId/CommandId are Guid.ToString("D"), Revision is an int
 *    (0 accepted / 1 executing / 2 succeeded), Outcome is a command-protocol outcome
 *    and OccurredAt is DateTimeOffset.ToString("O") — a round-trip ISO-8601 value that
 *    always carries an offset.
 *  - fab_shared/src/Generated/Contracts.g.cs does not contain this dev-only endpoint
 *    contract, so the record above is the authority.
 *
 * This module never coerces server data: a malformed payload raises instead of becoming
 * a 'undefined'-style string or a NaN revision, and the parsed response is returned with
 * the precise protocol types.
 */
import { Schema } from 'effect';
import { nonEmptyString, nonNegativeInteger, offsetDateTime } from '@/api/primitives.schema';
import type { CommandOutcome } from '@/contracts/command-events.contract';

/** Limits enforced by EquipmentCommandService.TryValidate/TryValidateIdempotencyKey. */
export const MAX_EQUIPMENT_ID_LENGTH = 128;
export const MAX_ACTION_LENGTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Authoritative wire outcomes. The development service only emits
 * accepted/executing/succeeded today, but failed/cancelled are terminal outcomes of the
 * shared command protocol (application/contracts/CommandEvents.ts, MessageDecoder and the
 * XState command machine), so they are valid wire values rather than unknown strings.
 */
const COMMAND_OUTCOMES = [
  'accepted',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly CommandOutcome[];

/** .NET Guid.TryParse accepts the "D" layout and its hyphenless/braced equivalents. */
const GUID_HEX = /^[0-9a-f]{32}$/i;
/** char.IsControl equivalent used by EquipmentCommandService.TryValidateIdempotencyKey. */
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

export const submitEquipmentCommandInputSchema = Schema.Struct({
  siteId: nonEmptyString, fabId: nonEmptyString,
  equipmentId: nonEmptyString.check(Schema.isMaxLength(MAX_EQUIPMENT_ID_LENGTH)),
  action: nonEmptyString.check(Schema.isMaxLength(MAX_ACTION_LENGTH)),
  idempotencyKey: nonEmptyString.check(Schema.isMaxLength(MAX_IDEMPOTENCY_KEY_LENGTH),
    Schema.makeFilter((key: string) => !hasControlCharacter(key) || 'idempotencyKey must not contain control characters')),
});
export const submittedEquipmentCommandSchema = Schema.Struct({
  commandId: nonEmptyString, siteId: nonEmptyString, fabId: nonEmptyString,
  equipmentId: nonEmptyString, action: nonEmptyString,
  revision: nonNegativeInteger, outcome: Schema.Literals(COMMAND_OUTCOMES), occurredAt: offsetDateTime,
});
export const decodeSubmitEquipmentCommandInput = Schema.decodeUnknownEffect(submitEquipmentCommandInputSchema);
export const decodeSubmittedEquipmentCommand = Schema.decodeUnknownEffect(submittedEquipmentCommandSchema);
export type SubmitEquipmentCommandInput = typeof submitEquipmentCommandInputSchema.Type;
export type SubmittedEquipmentCommand = typeof submittedEquipmentCommandSchema.Type;

/** Identity fields that bind a response to the submission it answers. */
export type CommandIdentityField = 'siteId' | 'fabId' | 'equipmentId' | 'action';

/** Canonical comparable form for GUID-shaped identity tokens, otherwise undefined. */
function canonicalGuid(value: string): string | undefined {
  const bare = value.trim().replace(/^\{([^}]*)\}$/, '$1').replace(/^\(([^)]*)\)$/, '$1');
  const compact = bare.replaceAll('-', '');
  return GUID_HEX.test(compact) ? compact.toLowerCase() : undefined;
}

/**
 * Protocol normalization: the backend parses Guid request identities and serializes them
 * with Guid.ToString("D"), so a GUID-shaped identity may come back re-cased/relaid out.
 * Any other identity token is opaque and must match byte for byte.
 */
export function commandIdentityMatches(submitted: string, returned: string): boolean {
  if (submitted === returned) return true;
  const canonical = canonicalGuid(submitted);
  return canonical !== undefined && canonical === canonicalGuid(returned);
}

/**
 * Cross-FAB guard: a response may only update the console/runtime of the FAB it was
 * submitted for. The service echoes equipmentId/action verbatim, so they must match
 * exactly; site/FAB identity follows the documented GUID normalization above.
 */
export function commandIdentityMismatches(
  submitted: SubmitEquipmentCommandInput,
  returned: SubmittedEquipmentCommand,
): CommandIdentityField[] {
  const mismatches: CommandIdentityField[] = [];
  if (!commandIdentityMatches(submitted.siteId, returned.siteId)) mismatches.push('siteId');
  if (!commandIdentityMatches(submitted.fabId, returned.fabId)) mismatches.push('fabId');
  if (submitted.equipmentId !== returned.equipmentId) mismatches.push('equipmentId');
  if (submitted.action !== returned.action) mismatches.push('action');
  return mismatches;
}

/**
 * Mints the idempotency key for one logical command submission. Retries of the same
 * logical command reuse the key; a different command mints a new one.
 */
export function createEquipmentCommandIdempotencyKey(): string {
  return crypto.randomUUID();
}
