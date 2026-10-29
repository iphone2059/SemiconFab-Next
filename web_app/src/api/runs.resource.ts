import { Effect } from 'effect';
import { queryOptions } from '@tanstack/react-query';
import { runListSchema, runResultSchema, runSummarySchema } from '@/api/runs.schema';
import { httpTransport, decodeApiResponse } from '@/api/http.transport';
import { queryKeys } from '@/api/query-keys';
export const fetchRuns = () => httpTransport.fetchJson('/api/v1/runs').pipe(Effect.flatMap(decodeApiResponse(runListSchema, 'invalid run list')));
export const fetchRun = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`).pipe(Effect.flatMap(decodeApiResponse(runSummarySchema, 'invalid run response')));
export const fetchRunResults = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}/results`).pipe(Effect.flatMap(decodeApiResponse(runResultSchema, 'invalid run result')));
export const runsQueryOptions = () => queryOptions({ queryKey: queryKeys.runs.all,
  queryFn: ({ signal }) => Effect.runPromise(fetchRuns(), { signal }), staleTime: 0, retry: 0 });
export const runQueryOptions = (runId: string) => queryOptions({ queryKey: queryKeys.runs.detail(runId),
  queryFn: ({ signal }) => Effect.runPromise(fetchRun(runId), { signal }), staleTime: 0, retry: 0 });
export const runResultsQueryOptions = (runId: string) => queryOptions({ queryKey: queryKeys.runs.results(runId),
  queryFn: ({ signal }) => Effect.runPromise(fetchRunResults(runId), { signal }), staleTime: 0, retry: 0 });
