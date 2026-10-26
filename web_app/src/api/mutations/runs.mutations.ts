import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { RunSummary } from '../../contracts';
import { fetchJson } from '../queries/http';
import { queryKeys } from '../queries/queryKeys';

const runSchema = z.looseObject({
  runId: z.string().min(1),
  siteId: z.string().min(1),
  status: z.string().min(1),
  version: z.string(),
  createdAtUtc: z.string(),
  executions: z.array(z.unknown()),
});

export interface CreateRunInput {
  readonly request: unknown;
  readonly idempotencyKey: string;
}

/** POST the run and invalidate the runs prefix so list/detail/result refresh. */
export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  const payload = await fetchJson('/api/v1/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(input.request),
  });
  return runSchema.parse(payload) as RunSummary;
}

export async function invalidateRuns(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
}
