import { createHttpTransport, type FetchLike } from '@/api/http.transport';
import {
  commandIdentityMismatches,
  submitEquipmentCommandInputSchema,
  submittedEquipmentCommandSchema,
  type SubmitEquipmentCommandInput,
  type SubmittedEquipmentCommand,
} from '@/api/command.schema';

export type { SubmitEquipmentCommandInput, SubmittedEquipmentCommand } from '@/api/command.schema';

/**
 * HTTP command submission; the SSE stream/CommandGateway provide later states.
 *
 * The shared transport owns the HTTP policy (same-origin relative URL, ProblemDetails
 * errors, non-JSON rejection), while this module owns the command schema: the response
 * must match SubmittedEquipmentCommand and echo the submitted site/FAB/equipment/action
 * identity (a response for another FAB is rejected, never tracked).
 */
export async function submitEquipmentCommand(
  input: SubmitEquipmentCommandInput,
  fetchImpl?: FetchLike,
): Promise<SubmittedEquipmentCommand> {
  const command = submitEquipmentCommandInputSchema.parse(input);
  const payload = await createHttpTransport({ fetchImpl }).fetchJson(
    '/api/v1/sites/' + encodeURIComponent(command.siteId) + '/commands',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': command.idempotencyKey,
      },
      body: JSON.stringify({ fabId: command.fabId, equipmentId: command.equipmentId, action: command.action }),
    },
  );
  const parsed = submittedEquipmentCommandSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const issuePath = issue ? issue.path.join('.') || 'root' : 'root';
    throw new Error('命令提交响应格式无效 / invalid command response: ' + issuePath + ': ' + (issue?.message ?? 'unknown'));
  }
  const mismatches = commandIdentityMismatches(command, parsed.data);
  if (mismatches.length > 0) {
    throw new Error('命令提交响应与提交上下文不一致 / command response identity mismatch: ' + mismatches.join(', '));
  }
  return parsed.data;
}
