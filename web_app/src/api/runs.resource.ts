import { Effect } from 'effect';
import { runListSchema, runResultSchema, runSummarySchema } from '@/api/runs.schema';
import { httpTransport, decodeApiResponse } from '@/api/http.transport';
import { makeResource, resourceFamily } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';

export const fetchRuns = () => httpTransport.fetchJson('/api/v1/runs').pipe(Effect.flatMap(decodeApiResponse(runListSchema, 'invalid run list')));
export const fetchRun = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`).pipe(Effect.flatMap(decodeApiResponse(runSummarySchema, 'invalid run response')));
export const fetchRunResults = (runId: string) => httpTransport.fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}/results`).pipe(Effect.flatMap(decodeApiResponse(runResultSchema, 'invalid run result')));

export const runsResource = makeResource(fetchRuns(), RESOURCE_POLICIES.runs);
export const runResource = resourceFamily((runId: string) => makeResource(fetchRun(runId), RESOURCE_POLICIES.runDetail));
export const runResultsResource = resourceFamily((runId: string) => makeResource(fetchRunResults(runId), RESOURCE_POLICIES.runResults));
