import type { QueryClient } from '@tanstack/react-query';
import type { RunSummary } from '../../contracts';
import { runSummarySchema } from '../schemas/runs.schema';
import { httpTransport } from '../transport/http';
import { queryKeys } from '../queries/queryKeys';

export interface CreateRunInput {
  readonly request: unknown;
  readonly idempotencyKey: string;
}

/** POST the run and invalidate the runs prefix so list/detail/result refresh. */
export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  const payload = await httpTransport.fetchJson('/api/v1/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(input.request),
  });
  return runSummarySchema.parse(payload);
}

export async function invalidateRuns(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
}
