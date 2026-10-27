export interface SubmitEquipmentCommandInput {
  readonly siteId: string;
  readonly fabId: string;
  readonly equipmentId: string;
  readonly action: string;
  /** Stable key for one logical command; retries must reuse it. */
  readonly idempotencyKey: string;
}

export interface SubmittedEquipmentCommand {
  readonly commandId: string;
  readonly siteId: string;
  readonly fabId: string;
  readonly equipmentId: string;
  readonly action: string;
  readonly revision: number;
  readonly outcome: string;
  readonly occurredAt: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** HTTP command submission; the SSE stream/CommandGateway provide later states. */
export async function submitEquipmentCommand(
  input: SubmitEquipmentCommandInput,
  fetchImpl: FetchLike = (target, init) => fetch(target, init),
): Promise<SubmittedEquipmentCommand> {
  const response = await fetchImpl(`/api/v1/sites/${encodeURIComponent(input.siteId)}/commands`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({ fabId: input.fabId, equipmentId: input.equipmentId, action: input.action }),
  });
  if (!response.ok) throw new Error(`command submission failed: ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.commandId !== 'string' || typeof body.fabId !== 'string') throw new Error('invalid command submission response');
  return {
    commandId: body.commandId,
    siteId: String(body.siteId),
    fabId: body.fabId,
    equipmentId: String(body.equipmentId),
    action: String(body.action),
    revision: Number(body.revision),
    outcome: String(body.outcome),
    occurredAt: String(body.occurredAt),
  };
}
