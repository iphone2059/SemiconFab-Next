import { Effect } from 'effect';
import type { QueryClient } from '@tanstack/react-query';
import type { CreateRunRequest, RunSummary } from '@/contracts/app-contracts';
import { decodeCreateRunRequest, runSummarySchema } from '@/api/runs.schema';
import { httpTransport, decodeApiResponse, InvalidRequest, type ApiError } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';

export interface CreateRunInput {
  readonly request: CreateRunRequest;
  readonly idempotencyKey: string;
}

/** POST the run and invalidate the runs prefix so list/detail/result refresh. */
export function createRun(input: CreateRunInput): Effect.Effect<RunSummary, ApiError> {
  return Effect.gen(function*() {
    const request = yield* decodeCreateRunRequest(input.request).pipe(Effect.mapError(cause => new InvalidRequest(cause.message, cause)));
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.idempotencyKey)) return yield* Effect.fail(new InvalidRequest('Invalid run idempotency key'));
    const payload = yield* httpTransport.fetchJson('/api/v1/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(request),
    });
    return yield* decodeApiResponse(runSummarySchema, 'invalid run response')(payload);
  });
}

export async function invalidateRuns(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
}
