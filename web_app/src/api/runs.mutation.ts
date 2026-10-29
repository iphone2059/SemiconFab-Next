import type { QueryClient } from '@tanstack/react-query';
import type { CreateRunRequest, RunSummary } from '@/contracts/app-contracts';
import { createRunRequestSchema, runSummarySchema } from '@/api/runs.schema';
import { httpTransport } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

export interface CreateRunInput {
  readonly request: CreateRunRequest;
  readonly idempotencyKey: string;
}

/** POST the run and invalidate the runs prefix so list/detail/result refresh. */
export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  const request = createRunRequestSchema.parse(input.request);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.idempotencyKey)) throw new Error('Invalid run idempotency key');
  const payload = await httpTransport.fetchJson('/api/v1/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(request),
  });
  return runSummarySchema.parse(payload);
}

export async function invalidateRuns(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
}
