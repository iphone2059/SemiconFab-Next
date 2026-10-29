import { Effect } from 'effect';
import { createHttpTransport, decodeApiResponse, InvalidRequest, CommandIdentityMismatch, type ApiError, type FetchLike } from '@/api/http.transport';
import { commandIdentityMismatches, decodeSubmitEquipmentCommandInput, submittedEquipmentCommandSchema,
  type SubmitEquipmentCommandInput, type SubmittedEquipmentCommand } from '@/api/command.schema';
export type { SubmitEquipmentCommandInput, SubmittedEquipmentCommand } from '@/api/command.schema';

export function submitEquipmentCommand(input: SubmitEquipmentCommandInput, fetchImpl?: FetchLike): Effect.Effect<SubmittedEquipmentCommand, ApiError> {
  return Effect.gen(function*() {
    const command = yield* decodeSubmitEquipmentCommandInput(input).pipe(Effect.mapError(cause => new InvalidRequest(cause.message, cause)));
    const payload = yield* createHttpTransport({ fetchImpl }).fetchJson(
      '/api/v1/sites/' + encodeURIComponent(command.siteId) + '/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.idempotencyKey },
        body: JSON.stringify({ fabId: command.fabId, equipmentId: command.equipmentId, action: command.action }),
      });
    const parsed = yield* decodeApiResponse(submittedEquipmentCommandSchema, '命令提交响应格式无效 / invalid command response')(payload);
    const mismatches = commandIdentityMismatches(command, parsed);
    if (mismatches.length > 0) return yield* Effect.fail(new CommandIdentityMismatch(mismatches));
    return parsed;
  });
}
