import { makeResource, resourceFamily } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';
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

/** Run list resource; freshness 0 so every mount/navigation checks authority. */
export const runsResource = makeResource(fetchRuns(), RESOURCE_POLICIES.runs);
export const runResource = resourceFamily((runId: string) => makeResource(fetchRun(runId), RESOURCE_POLICIES.runDetail));
export const runResultsResource = resourceFamily((runId: string) => makeResource(fetchRunResults(runId), RESOURCE_POLICIES.runResults));
